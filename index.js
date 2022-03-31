"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrowApi = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const cdk = require("aws-cdk-lib");
const constructs_1 = require("constructs");
const lambda = require("aws-cdk-lib/aws-lambda");
const node_lambda = require("aws-cdk-lib/aws-lambda-nodejs");
const apigateway = require("aws-cdk-lib/aws-apigateway");
const logs = require("aws-cdk-lib/aws-logs");
/**
 * For copying shared code to all paths
 */
const fse = require("fs-extra");
/**
 * @experimental
 */
class CrowApi extends constructs_1.Construct {
    /**
     * @experimental
     */
    constructor(scope, id, props) {
        super(scope, id);
        // Pulling out props
        const { sourceDirectory = "src", sharedDirectory = "shared", useAuthorizerLambda = false, authorizerDirectory = "authorizer", authorizerLambdaConfiguration = {}, tokenAuthorizerConfiguration = {}, createApiKey = false, logRetention = logs.RetentionDays.ONE_WEEK, apiGatewayConfiguration = {}, apiGatewayName = "crow-api", lambdaConfigurations = {}, lambdaIntegrationOptions = {}, models = [], requestValidators = [], methodConfigurations = {} } = props;
        // Initializing constants
        const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_14_X;
        const SPECIAL_DIRECTORIES = [sharedDirectory, authorizerDirectory];
        // Helpers functions for constructor
        // Prepares default Lambda props and overrides them with user input
        function bundleLambdaProps(codePath, userConfiguration, sharedLayer) {
            let layers;
            if (sharedLayer) {
                const { layers: userLayers = [] } = userConfiguration;
                layers = [sharedLayer, ...userLayers];
            }
            const defaultProps = {
                runtime: LAMBDA_RUNTIME,
                code: lambda.Code.fromAsset(codePath),
                entry: `${codePath}/index.js`,
                handler: "handler",
                logRetention
            };
            const lambdaProps = {
                ...defaultProps,
                ...userConfiguration,
                layers
            };
            return lambdaProps;
        }
        function getLambdaConfig(newApiPath) {
            // if direct match return right away
            if (lambdaConfigurations[newApiPath]) {
                return lambdaConfigurations[newApiPath];
            }
            // check all route wild card options for matching configs
            let baseRoute = "";
            const match = newApiPath
                .split("/")
                .map((segment) => {
                if (segment) {
                    baseRoute += `/${segment}`;
                }
                return `${baseRoute}/*`;
            })
                .find((wildcard) => !!lambdaConfigurations[wildcard]);
            if (match) {
                return lambdaConfigurations[match];
            }
            // returns empty config
            return {};
        }
        // Returns child directories given the path of a parent
        function getDirectoryChildren(parentDirectory) {
            try {
                const directories = fse
                    .readdirSync(parentDirectory, { withFileTypes: true })
                    .filter((dirent) => dirent.isDirectory())
                    .map((dirent) => dirent.name);
                return directories;
            }
            catch {
                /**
                 * The only time I have run into this was when the src/ directory
                 * was empty.
                 * If it is empty, let CDK tree validation tell user that the
                 * REST API does not have any methods.
                 */
            }
            return [];
        }
        // API Gateway log group
        const gatewayLogGroup = new logs.LogGroup(this, "api-access-logs", {
            retention: logs.RetentionDays.ONE_WEEK
        });
        // The API Gateway itself
        const gateway = new apigateway.RestApi(this, apiGatewayName, {
            deploy: true,
            deployOptions: {
                loggingLevel: apigateway.MethodLoggingLevel.ERROR,
                accessLogDestination: new apigateway.LogGroupLogDestination(gatewayLogGroup)
            },
            apiKeySourceType: createApiKey ? apigateway.ApiKeySourceType.HEADER : undefined,
            ...apiGatewayConfiguration
        });
        const createdModels = {};
        models.forEach((model) => {
            // modelName is used as ID and can now be used for referencing model in method options
            createdModels[model.modelName] = gateway.addModel(model.modelName, model);
        });
        const createdRequestValidators = {};
        requestValidators.forEach((requestValidator) => {
            // requestValidatorName is used as ID and can now be used for referencing model in method options
            createdRequestValidators[requestValidator.requestValidatorName] = gateway.addRequestValidator(requestValidator.requestValidatorName, requestValidator);
        });
        // Create API key if desired
        if (createApiKey) {
            const apiKey = gateway.addApiKey("api-key");
            const usagePlan = new apigateway.UsagePlan(this, "usage-plan", {
                throttle: {
                    burstLimit: 5000,
                    rateLimit: 10000
                },
                apiStages: [
                    {
                        api: gateway,
                        stage: gateway.deploymentStage
                    }
                ]
            });
            usagePlan.addApiKey(apiKey);
            this.usagePlan = usagePlan;
        }
        // Create Lambda layer out of shared directory if it exists
        const sourceSharedDirectory = `${sourceDirectory}/${sharedDirectory}`;
        let sharedLayer;
        if (fse.existsSync(sourceSharedDirectory)) {
            sharedLayer = new lambda.LayerVersion(this, "shared-layer", {
                code: lambda.Code.fromAsset(sourceSharedDirectory),
                compatibleRuntimes: [LAMBDA_RUNTIME],
                removalPolicy: cdk.RemovalPolicy.DESTROY
            });
            this.lambdaLayer = sharedLayer;
        }
        // Create Lambda authorizer to be used in subsequent Methods
        let tokenAuthorizer;
        if (useAuthorizerLambda) {
            const fullAuthorizerDirectory = `${sourceDirectory}/${authorizerDirectory}`;
            const authorizerLambdaProps = bundleLambdaProps(fullAuthorizerDirectory, authorizerLambdaConfiguration, sharedLayer);
            const authorizerLambda = new node_lambda.NodejsFunction(this, "authorizer-lambda", authorizerLambdaProps);
            this.authorizerLambda = authorizerLambda;
            const bundledTokenAuthConfig = {
                handler: authorizerLambda,
                resultsCacheTtl: cdk.Duration.seconds(3600),
                ...tokenAuthorizerConfiguration
            };
            tokenAuthorizer = new apigateway.TokenAuthorizer(this, "token-authorizer", bundledTokenAuthConfig);
            this.authorizer = tokenAuthorizer;
        }
        // Time to start walking the directories
        const root = sourceDirectory;
        const verbs = ["get", "post", "put", "delete"];
        const graph = {};
        const lambdasByPath = {};
        // Initialize with root
        graph["/"] = {
            resource: gateway.root,
            path: root,
            paths: [],
            verbs: []
        };
        // First element in tuple is directory path, second is API path
        const nodes = [[root, "/"]];
        // BFS that creates API Gateway structure using addMethod
        while (nodes.length) {
            // The `|| ['type', 'script']` piece is needed or TS throws a fit
            const [directoryPath, apiPath] = nodes.shift() || ["type", "script"];
            const children = getDirectoryChildren(directoryPath);
            // For debugging purposes
            // console.log(`${apiPath}'s children are: ${children}`);
            // Don't have to worry about previously visited nodes
            // since this is a file structure
            // ...unless there are symlinks? Haven't run into that
            children.forEach((child) => {
                const newDirectoryPath = `${directoryPath}/${child}`;
                // If we're on the root path, don't separate with a slash (/)
                //   because it ends up looking like //child-path
                const newApiPath = apiPath === "/" ? `/${child}` : `${apiPath}/${child}`;
                if (verbs.includes(child)) {
                    // If directory is a verb, we don't traverse it anymore
                    //   and need to create an API Gateway method and Lambda
                    const userLambdaConfiguration = getLambdaConfig(newApiPath);
                    const lambdaProps = bundleLambdaProps(newDirectoryPath, userLambdaConfiguration, sharedLayer);
                    const newLambda = new node_lambda.NodejsFunction(this, newDirectoryPath, lambdaProps);
                    // Pull out useAuthorizerLambda value and the tweaked model values
                    const { useAuthorizerLambda: authorizerLambdaConfigured = false, requestModels: crowRequestModels, methodResponses: crowMethodResponses, requestValidator: requestValidatorString, ...userMethodConfiguration } = methodConfigurations[newApiPath] || {};
                    let bundledMethodConfiguration = {
                        ...userMethodConfiguration
                    };
                    // Map models
                    const requestModels = {};
                    if (crowRequestModels) {
                        Object.entries(crowRequestModels).forEach(([contentType, modelName]) => {
                            requestModels[contentType] = createdModels[modelName];
                        });
                    }
                    const methodResponses = [];
                    if (crowMethodResponses && crowMethodResponses.length > 0) {
                        crowMethodResponses.forEach((crowMethodResponse) => {
                            const responseModels = {};
                            if (crowMethodResponse.responseModels) {
                                const crowResponseModels = crowMethodResponse.responseModels;
                                Object.entries(crowResponseModels).forEach(([contentType, modelName]) => {
                                    responseModels[contentType] = createdModels[modelName];
                                });
                            }
                            const { statusCode, responseParameters } = crowMethodResponse;
                            methodResponses.push({
                                statusCode,
                                responseParameters,
                                responseModels
                            });
                        });
                    }
                    // Find request validator
                    if (requestValidatorString && createdRequestValidators[requestValidatorString]) {
                        bundledMethodConfiguration.requestValidator = createdRequestValidators[requestValidatorString];
                    }
                    bundledMethodConfiguration.requestModels = requestModels;
                    bundledMethodConfiguration.methodResponses = methodResponses;
                    // If this method should be behind an authorizer Lambda
                    //   construct the methodConfiguration object as such
                    if (authorizerLambdaConfigured && useAuthorizerLambda) {
                        bundledMethodConfiguration.authorizationType = apigateway.AuthorizationType.CUSTOM;
                        bundledMethodConfiguration.authorizer = tokenAuthorizer;
                    }
                    const integrationOptions = lambdaIntegrationOptions[newApiPath] || {};
                    graph[apiPath].resource.addMethod(child.toUpperCase(), new apigateway.LambdaIntegration(newLambda, integrationOptions), bundledMethodConfiguration);
                    graph[apiPath].verbs.push(child);
                    lambdasByPath[newApiPath] = newLambda;
                }
                else if (SPECIAL_DIRECTORIES.includes(child)) {
                    // The special directories should not result in an API path
                    // This means the API also cannot have a resource with the
                    //   same name
                }
                else {
                    // If directory is not a verb, create new API Gateway resource
                    //   for use by verb directory later
                    const newResource = graph[apiPath].resource.resourceForPath(child);
                    nodes.push([newDirectoryPath, newApiPath]);
                    // Add child to parent's paths
                    graph[apiPath].paths.push(child);
                    // Initialize graph node to include child
                    graph[newApiPath] = {
                        resource: newResource,
                        path: newDirectoryPath,
                        paths: [],
                        verbs: []
                    };
                }
            });
        }
        // For debugging purposes
        // console.log(graph);
        // Expose API Gateway
        this.gateway = gateway;
        this.lambdaFunctions = lambdasByPath;
        this.models = createdModels;
        this.requestValidators = createdRequestValidators;
    }
}
exports.CrowApi = CrowApi;
_a = JSII_RTTI_SYMBOL_1;
CrowApi[_a] = { fqn: "crow-api.CrowApi", version: "2.3.3" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBdUM7QUFDdkMsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBRTdDOztHQUVHO0FBQ0gsZ0NBQWdDOzs7O0FBZ0doQyxNQUFhLE9BQVEsU0FBUSxzQkFBUzs7OztJQVdwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsb0JBQW9CO1FBQ3BCLE1BQU0sRUFDSixlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsUUFBUSxFQUMxQixtQkFBbUIsR0FBRyxLQUFLLEVBQzNCLG1CQUFtQixHQUFHLFlBQVksRUFDbEMsNkJBQTZCLEdBQUcsRUFBRSxFQUNsQyw0QkFBNEIsR0FBRyxFQUFFLEVBQ2pDLFlBQVksR0FBRyxLQUFLLEVBQ3BCLFlBQVksR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFDMUMsdUJBQXVCLEdBQUcsRUFBRSxFQUM1QixjQUFjLEdBQUcsVUFBVSxFQUMzQixvQkFBb0IsR0FBRyxFQUFFLEVBQ3pCLHdCQUF3QixHQUFHLEVBQUUsRUFDN0IsTUFBTSxHQUFHLEVBQUUsRUFDWCxpQkFBaUIsR0FBRyxFQUFFLEVBQ3RCLG9CQUFvQixHQUFHLEVBQUUsRUFDMUIsR0FBRyxLQUFLLENBQUM7UUFFVix5QkFBeUI7UUFDekIsTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUM7UUFDbEQsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLGVBQWUsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRW5FLG9DQUFvQztRQUVwQyxtRUFBbUU7UUFDbkUsU0FBUyxpQkFBaUIsQ0FDeEIsUUFBZ0IsRUFDaEIsaUJBQWtELEVBQ2xE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LElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxlQUFlLEdBQUcsYUFBYSxDQUFDO1FBQ3JDLElBQUksQ0FBQyxNQUFNLEdBQUcsYUFBYSxDQUFDO1FBQzVCLElBQUksQ0FBQyxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztJQUNwRCxDQUFDOztBQS9VSCwwQkFnVkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBub2RlX2xhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanNcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuXG4vKipcbiAqIEZvciBjb3B5aW5nIHNoYXJlZCBjb2RlIHRvIGFsbCBwYXRoc1xuICovXG5pbXBvcnQgKiBhcyBmc2UgZnJvbSBcImZzLWV4dHJhXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGFtYmRhc0J5UGF0aCB7XG4gIFtwYXRoOiBzdHJpbmddOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93TGFtYmRhQ29uZmlndXJhdGlvbnMge1xuICBbbGFtYmRhQnlQYXRoOiBzdHJpbmddOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzO1xufVxuXG4vLyBTYW1lIGFzIE1vZGVsT3B0aW9ucyBidXQgbW9kZWxOYW1lIGlzIHJlcXVpcmVkICh1c2VkIGFzIElEKVxuZXhwb3J0IGludGVyZmFjZSBDcm93TW9kZWxPcHRpb25zIHtcbiAgcmVhZG9ubHkgc2NoZW1hOiBhcGlnYXRld2F5Lkpzb25TY2hlbWE7XG4gIHJlYWRvbmx5IG1vZGVsTmFtZTogc3RyaW5nO1xuICByZWFkb25seSBjb250ZW50VHlwZT86IHN0cmluZztcbiAgcmVhZG9ubHkgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG59XG5cbi8vIFNhbWUgYXMgUmVxdWVzdFZhbGlkYXRvck9wdGlvbnMgYnV0IHJlcXVlc3RWYWxpZGF0b3JOYW1lIGlzIHJlcXVpcmVkICh1c2VkIGFzIElEKVxuZXhwb3J0IGludGVyZmFjZSBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnMge1xuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9yTmFtZTogc3RyaW5nO1xuICByZWFkb25seSB2YWxpZGF0ZVJlcXVlc3RCb2R5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgdmFsaWRhdGVSZXF1ZXN0UGFyYW1ldGVycz86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01ldGhvZFJlc3BvbnNlIHtcbiAgcmVhZG9ubHkgc3RhdHVzQ29kZTogc3RyaW5nO1xuICAvLyBUYWtlcyBhIHN0cmluZyB3aGljaCBpcyBtYXRjaGVkIHdpdGggdGhlIG1vZGVsTmFtZVxuICByZWFkb25seSByZXNwb25zZU1vZGVscz86IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgcmVhZG9ubHkgcmVzcG9uc2VQYXJhbWV0ZXJzPzogeyBbcGFyYW06IHN0cmluZ106IGJvb2xlYW4gfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93TWV0aG9kQ29uZmlndXJhdGlvbiB7XG4gIC8vIFJlZGVmaW5pbmcgTWV0aG9kT3B0aW9ucyBzaW5jZSBPbWl0IGlzIG5vdCBzdXBwb3J0ZWRcbiAgcmVhZG9ubHkgYXBpS2V5UmVxdWlyZWQ/OiBib29sZWFuO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2NvcGVzPzogc3RyaW5nW107XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25UeXBlPzogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZTtcbiAgcmVhZG9ubHkgYXV0aG9yaXplcj86IGFwaWdhdGV3YXkuSUF1dGhvcml6ZXI7XG4gIHJlYWRvbmx5IG1ldGhvZFJlc3BvbnNlcz86IENyb3dNZXRob2RSZXNwb25zZVtdO1xuICByZWFkb25seSBvcGVyYXRpb25OYW1lPzogc3RyaW5nO1xuICAvLyBUYWtlcyBhIHN0cmluZyB3aGljaCBpcyBtYXRjaGVkIHdpdGggdGhlIG1vZGVsTmFtZVxuICByZWFkb25seSByZXF1ZXN0TW9kZWxzPzogeyBbY29udGVudFR5cGU6IHN0cmluZ106IHN0cmluZyB9O1xuICByZWFkb25seSByZXF1ZXN0UGFyYW1ldGVycz86IHsgW3BhcmFtOiBzdHJpbmddOiBib29sZWFuIH07XG4gIC8vIFRha2VzIGEgc3RyaW5nIHdoaWNoIGlzIG1hdGNoZWQgd2l0aCB0aGUgcmVxdWVzdFZhbGlkYXRvck5hbWVcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvcj86IHN0cmluZztcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvck9wdGlvbnM/OiBhcGlnYXRld2F5LlJlcXVlc3RWYWxpZGF0b3JPcHRpb25zO1xuICByZWFkb25seSB1c2VBdXRob3JpemVyTGFtYmRhPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93TWV0aG9kQ29uZmlndXJhdGlvbnMge1xuICAvLyBtZXRob2RCeVBhdGggc2hvdWxkIGJlIGxhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICBbbWV0aG9kQnlQYXRoOiBzdHJpbmddOiBDcm93TWV0aG9kQ29uZmlndXJhdGlvbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93QXBpUHJvcHMge1xuICByZWFkb25seSBzb3VyY2VEaXJlY3Rvcnk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHNoYXJlZERpcmVjdG9yeT86IHN0cmluZztcbiAgcmVhZG9ubHkgdXNlQXV0aG9yaXplckxhbWJkYT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJEaXJlY3Rvcnk/OiBzdHJpbmc7XG4gIC8vIGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmF0aW9uIHNob3VsZCBiZSBsYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgcmVhZG9ubHkgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24/OiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzIHwgYW55O1xuICAvLyBhdXRob3JpemVyQ29uZmlndXJhdGlvbiBzaG91bGQgYmUgYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXJQcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgcmVhZG9ubHkgdG9rZW5BdXRob3JpemVyQ29uZmlndXJhdGlvbj86IGFwaWdhdGV3YXkuVG9rZW5BdXRob3JpemVyUHJvcHMgfCBhbnk7XG4gIHJlYWRvbmx5IGNyZWF0ZUFwaUtleT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGxvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgLy8gYXBpR2F0d2F5Q29uZmlndXJhdGlvbiBzaG91bGQgYmUgYXBpZ2F0ZXdheS5MYW1iZGFSZXN0QXBpUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIHJlYWRvbmx5IGFwaUdhdGV3YXlDb25maWd1cmF0aW9uPzogYXBpZ2F0ZXdheS5SZXN0QXBpUHJvcHMgfCBhbnk7XG4gIHJlYWRvbmx5IGFwaUdhdGV3YXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBsYW1iZGFDb25maWd1cmF0aW9ucz86IENyb3dMYW1iZGFDb25maWd1cmF0aW9ucztcbiAgcmVhZG9ubHkgbGFtYmRhSW50ZWdyYXRpb25PcHRpb25zPzoge1xuICAgIFtsYW1iZGFQYXRoOiBzdHJpbmddOiBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uT3B0aW9ucztcbiAgfTtcbiAgcmVhZG9ubHkgbW9kZWxzPzogQ3Jvd01vZGVsT3B0aW9uc1tdO1xuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9ycz86IENyb3dSZXF1ZXN0VmFsaWRhdG9yT3B0aW9uc1tdO1xuICByZWFkb25seSBtZXRob2RDb25maWd1cmF0aW9ucz86IENyb3dNZXRob2RDb25maWd1cmF0aW9ucztcbn1cblxuaW50ZXJmYWNlIEZTR3JhcGhOb2RlIHtcbiAgcmVzb3VyY2U6IGFwaWdhdGV3YXkuSVJlc291cmNlO1xuICBwYXRoOiBzdHJpbmc7XG4gIHBhdGhzOiBzdHJpbmdbXTtcbiAgdmVyYnM6IHN0cmluZ1tdO1xufVxuXG5pbnRlcmZhY2UgRlNHcmFwaCB7XG4gIFtwYXRoOiBzdHJpbmddOiBGU0dyYXBoTm9kZTtcbn1cblxuZXhwb3J0IGNsYXNzIENyb3dBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgZ2F0ZXdheSE6IGFwaWdhdGV3YXkuUmVzdEFwaTtcbiAgcHVibGljIHVzYWdlUGxhbiE6IGFwaWdhdGV3YXkuVXNhZ2VQbGFuO1xuICBwdWJsaWMgYXV0aG9yaXplciE6IGFwaWdhdGV3YXkuSUF1dGhvcml6ZXI7XG4gIHB1YmxpYyBhdXRob3JpemVyTGFtYmRhITogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb247XG4gIHB1YmxpYyBsYW1iZGFMYXllciE6IGxhbWJkYS5MYXllclZlcnNpb24gfCB1bmRlZmluZWQ7XG4gIHB1YmxpYyBsYW1iZGFGdW5jdGlvbnMhOiBMYW1iZGFzQnlQYXRoO1xuICBwdWJsaWMgbW9kZWxzITogeyBbbW9kZWxOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbCB9O1xuICBwdWJsaWMgcmVxdWVzdFZhbGlkYXRvcnMhOiB7IFtyZXF1ZXN0VmFsaWRhdG9yc05hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSVJlcXVlc3RWYWxpZGF0b3IgfTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IENyb3dBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyBQdWxsaW5nIG91dCBwcm9wc1xuICAgIGNvbnN0IHtcbiAgICAgIHNvdXJjZURpcmVjdG9yeSA9IFwic3JjXCIsXG4gICAgICBzaGFyZWREaXJlY3RvcnkgPSBcInNoYXJlZFwiLFxuICAgICAgdXNlQXV0aG9yaXplckxhbWJkYSA9IGZhbHNlLFxuICAgICAgYXV0aG9yaXplckRpcmVjdG9yeSA9IFwiYXV0aG9yaXplclwiLFxuICAgICAgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIHRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIGNyZWF0ZUFwaUtleSA9IGZhbHNlLFxuICAgICAgbG9nUmV0ZW50aW9uID0gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIGFwaUdhdGV3YXlOYW1lID0gXCJjcm93LWFwaVwiLFxuICAgICAgbGFtYmRhQ29uZmlndXJhdGlvbnMgPSB7fSxcbiAgICAgIGxhbWJkYUludGVncmF0aW9uT3B0aW9ucyA9IHt9LFxuICAgICAgbW9kZWxzID0gW10sXG4gICAgICByZXF1ZXN0VmFsaWRhdG9ycyA9IFtdLFxuICAgICAgbWV0aG9kQ29uZmlndXJhdGlvbnMgPSB7fVxuICAgIH0gPSBwcm9wcztcblxuICAgIC8vIEluaXRpYWxpemluZyBjb25zdGFudHNcbiAgICBjb25zdCBMQU1CREFfUlVOVElNRSA9IGxhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YO1xuICAgIGNvbnN0IFNQRUNJQUxfRElSRUNUT1JJRVMgPSBbc2hhcmVkRGlyZWN0b3J5LCBhdXRob3JpemVyRGlyZWN0b3J5XTtcblxuICAgIC8vIEhlbHBlcnMgZnVuY3Rpb25zIGZvciBjb25zdHJ1Y3RvclxuXG4gICAgLy8gUHJlcGFyZXMgZGVmYXVsdCBMYW1iZGEgcHJvcHMgYW5kIG92ZXJyaWRlcyB0aGVtIHdpdGggdXNlciBpbnB1dFxuICAgIGZ1bmN0aW9uIGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgY29kZVBhdGg6IHN0cmluZyxcbiAgICAgIHVzZXJDb25maWd1cmF0aW9uOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzLFxuICAgICAgc2hhcmVkTGF5ZXI6IGxhbWJkYS5MYXllclZlcnNpb24gfCB1bmRlZmluZWRcbiAgICApIHtcbiAgICAgIGxldCBsYXllcnM7XG4gICAgICBpZiAoc2hhcmVkTGF5ZXIpIHtcbiAgICAgICAgY29uc3QgeyBsYXllcnM6IHVzZXJMYXllcnMgPSBbXSB9ID0gdXNlckNvbmZpZ3VyYXRpb247XG4gICAgICAgIGxheWVycyA9IFtzaGFyZWRMYXllciwgLi4udXNlckxheWVyc107XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICAgICAgcnVudGltZTogTEFNQkRBX1JVTlRJTUUsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChjb2RlUGF0aCksXG4gICAgICAgIGVudHJ5OiBgJHtjb2RlUGF0aH0vaW5kZXguanNgLFxuICAgICAgICBoYW5kbGVyOiBcImhhbmRsZXJcIixcbiAgICAgICAgbG9nUmV0ZW50aW9uXG4gICAgICB9O1xuXG4gICAgICBjb25zdCBsYW1iZGFQcm9wcyA9IHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICAuLi51c2VyQ29uZmlndXJhdGlvbiwgLy8gTGV0IHVzZXIgY29uZmlndXJhdGlvbiBvdmVycmlkZSBhbnl0aGluZyBleGNlcHQgbGF5ZXJzXG4gICAgICAgIGxheWVyc1xuICAgICAgfTtcblxuICAgICAgcmV0dXJuIGxhbWJkYVByb3BzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldExhbWJkYUNvbmZpZyhuZXdBcGlQYXRoOiBzdHJpbmcpIHtcbiAgICAgIC8vIGlmIGRpcmVjdCBtYXRjaCByZXR1cm4gcmlnaHQgYXdheVxuICAgICAgaWYgKGxhbWJkYUNvbmZpZ3VyYXRpb25zW25ld0FwaVBhdGhdKSB7XG4gICAgICAgIHJldHVybiBsYW1iZGFDb25maWd1cmF0aW9uc1tuZXdBcGlQYXRoXTtcbiAgICAgIH1cblxuICAgICAgLy8gY2hlY2sgYWxsIHJvdXRlIHdpbGQgY2FyZCBvcHRpb25zIGZvciBtYXRjaGluZyBjb25maWdzXG4gICAgICBsZXQgYmFzZVJvdXRlOiBzdHJpbmcgPSBcIlwiO1xuICAgICAgY29uc3QgbWF0Y2g6IHN0cmluZyB8IHVuZGVmaW5lZCA9IG5ld0FwaVBhdGhcbiAgICAgICAgLnNwbGl0KFwiL1wiKVxuICAgICAgICAubWFwKChzZWdtZW50KSA9PiB7XG4gICAgICAgICAgaWYgKHNlZ21lbnQpIHtcbiAgICAgICAgICAgIGJhc2VSb3V0ZSArPSBgLyR7c2VnbWVudH1gO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCR7YmFzZVJvdXRlfS8qYDtcbiAgICAgICAgfSlcbiAgICAgICAgLmZpbmQoKHdpbGRjYXJkKSA9PiAhIWxhbWJkYUNvbmZpZ3VyYXRpb25zW3dpbGRjYXJkXSk7XG5cbiAgICAgIGlmIChtYXRjaCkge1xuICAgICAgICByZXR1cm4gbGFtYmRhQ29uZmlndXJhdGlvbnNbbWF0Y2hdO1xuICAgICAgfVxuXG4gICAgICAvLyByZXR1cm5zIGVtcHR5IGNvbmZpZ1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cblxuICAgIC8vIFJldHVybnMgY2hpbGQgZGlyZWN0b3JpZXMgZ2l2ZW4gdGhlIHBhdGggb2YgYSBwYXJlbnRcbiAgICBmdW5jdGlvbiBnZXREaXJlY3RvcnlDaGlsZHJlbihwYXJlbnREaXJlY3Rvcnk6IHN0cmluZykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZGlyZWN0b3JpZXMgPSBmc2VcbiAgICAgICAgICAucmVhZGRpclN5bmMocGFyZW50RGlyZWN0b3J5LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgICAgICAuZmlsdGVyKChkaXJlbnQ6IGFueSkgPT4gZGlyZW50LmlzRGlyZWN0b3J5KCkpXG4gICAgICAgICAgLm1hcCgoZGlyZW50OiBhbnkpID0+IGRpcmVudC5uYW1lKTtcbiAgICAgICAgcmV0dXJuIGRpcmVjdG9yaWVzO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBUaGUgb25seSB0aW1lIEkgaGF2ZSBydW4gaW50byB0aGlzIHdhcyB3aGVuIHRoZSBzcmMvIGRpcmVjdG9yeVxuICAgICAgICAgKiB3YXMgZW1wdHkuXG4gICAgICAgICAqIElmIGl0IGlzIGVtcHR5LCBsZXQgQ0RLIHRyZWUgdmFsaWRhdGlvbiB0ZWxsIHVzZXIgdGhhdCB0aGVcbiAgICAgICAgICogUkVTVCBBUEkgZG9lcyBub3QgaGF2ZSBhbnkgbWV0aG9kcy5cbiAgICAgICAgICovXG4gICAgICB9XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuXG4gICAgLy8gQVBJIEdhdGV3YXkgbG9nIGdyb3VwXG4gICAgY29uc3QgZ2F0ZXdheUxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJhcGktYWNjZXNzLWxvZ3NcIiwge1xuICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUtcbiAgICB9KTtcblxuICAgIC8vIFRoZSBBUEkgR2F0ZXdheSBpdHNlbGZcbiAgICBjb25zdCBnYXRld2F5ID0gbmV3IGFwaWdhdGV3YXkuUmVzdEFwaSh0aGlzLCBhcGlHYXRld2F5TmFtZSwge1xuICAgICAgZGVwbG95OiB0cnVlLFxuICAgICAgZGVwbG95T3B0aW9uczoge1xuICAgICAgICBsb2dnaW5nTGV2ZWw6IGFwaWdhdGV3YXkuTWV0aG9kTG9nZ2luZ0xldmVsLkVSUk9SLFxuICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogbmV3IGFwaWdhdGV3YXkuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihnYXRld2F5TG9nR3JvdXApXG4gICAgICB9LFxuICAgICAgYXBpS2V5U291cmNlVHlwZTogY3JlYXRlQXBpS2V5ID8gYXBpZ2F0ZXdheS5BcGlLZXlTb3VyY2VUeXBlLkhFQURFUiA6IHVuZGVmaW5lZCxcbiAgICAgIC4uLmFwaUdhdGV3YXlDb25maWd1cmF0aW9uXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVkTW9kZWxzOiB7IFttb2RlbE5hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH0gPSB7fTtcbiAgICBtb2RlbHMuZm9yRWFjaCgobW9kZWw6IENyb3dNb2RlbE9wdGlvbnMpID0+IHtcbiAgICAgIC8vIG1vZGVsTmFtZSBpcyB1c2VkIGFzIElEIGFuZCBjYW4gbm93IGJlIHVzZWQgZm9yIHJlZmVyZW5jaW5nIG1vZGVsIGluIG1ldGhvZCBvcHRpb25zXG4gICAgICBjcmVhdGVkTW9kZWxzW21vZGVsLm1vZGVsTmFtZV0gPSBnYXRld2F5LmFkZE1vZGVsKG1vZGVsLm1vZGVsTmFtZSwgbW9kZWwpO1xuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9yczogeyBbcmVxdWVzdFZhbGlkYXRvcnNOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklSZXF1ZXN0VmFsaWRhdG9yIH0gPSB7fTtcbiAgICByZXF1ZXN0VmFsaWRhdG9ycy5mb3JFYWNoKChyZXF1ZXN0VmFsaWRhdG9yOiBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnMpID0+IHtcbiAgICAgIC8vIHJlcXVlc3RWYWxpZGF0b3JOYW1lIGlzIHVzZWQgYXMgSUQgYW5kIGNhbiBub3cgYmUgdXNlZCBmb3IgcmVmZXJlbmNpbmcgbW9kZWwgaW4gbWV0aG9kIG9wdGlvbnNcbiAgICAgIGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9yc1tyZXF1ZXN0VmFsaWRhdG9yLnJlcXVlc3RWYWxpZGF0b3JOYW1lXSA9IGdhdGV3YXkuYWRkUmVxdWVzdFZhbGlkYXRvcihcbiAgICAgICAgcmVxdWVzdFZhbGlkYXRvci5yZXF1ZXN0VmFsaWRhdG9yTmFtZSxcbiAgICAgICAgcmVxdWVzdFZhbGlkYXRvclxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIC8vIENyZWF0ZSBBUEkga2V5IGlmIGRlc2lyZWRcbiAgICBpZiAoY3JlYXRlQXBpS2V5KSB7XG4gICAgICBjb25zdCBhcGlLZXkgPSBnYXRld2F5LmFkZEFwaUtleShcImFwaS1rZXlcIik7XG4gICAgICBjb25zdCB1c2FnZVBsYW4gPSBuZXcgYXBpZ2F0ZXdheS5Vc2FnZVBsYW4odGhpcywgXCJ1c2FnZS1wbGFuXCIsIHtcbiAgICAgICAgdGhyb3R0bGU6IHtcbiAgICAgICAgICBidXJzdExpbWl0OiA1MDAwLFxuICAgICAgICAgIHJhdGVMaW1pdDogMTAwMDBcbiAgICAgICAgfSxcbiAgICAgICAgYXBpU3RhZ2VzOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgYXBpOiBnYXRld2F5LFxuICAgICAgICAgICAgc3RhZ2U6IGdhdGV3YXkuZGVwbG95bWVudFN0YWdlXG4gICAgICAgICAgfVxuICAgICAgICBdXG4gICAgICB9KTtcbiAgICAgIHVzYWdlUGxhbi5hZGRBcGlLZXkoYXBpS2V5KTtcbiAgICAgIHRoaXMudXNhZ2VQbGFuID0gdXNhZ2VQbGFuO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBMYW1iZGEgbGF5ZXIgb3V0IG9mIHNoYXJlZCBkaXJlY3RvcnkgaWYgaXQgZXhpc3RzXG4gICAgY29uc3Qgc291cmNlU2hhcmVkRGlyZWN0b3J5ID0gYCR7c291cmNlRGlyZWN0b3J5fS8ke3NoYXJlZERpcmVjdG9yeX1gO1xuICAgIGxldCBzaGFyZWRMYXllcjogbGFtYmRhLkxheWVyVmVyc2lvbiB8IHVuZGVmaW5lZDtcbiAgICBpZiAoZnNlLmV4aXN0c1N5bmMoc291cmNlU2hhcmVkRGlyZWN0b3J5KSkge1xuICAgICAgc2hhcmVkTGF5ZXIgPSBuZXcgbGFtYmRhLkxheWVyVmVyc2lvbih0aGlzLCBcInNoYXJlZC1sYXllclwiLCB7XG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChzb3VyY2VTaGFyZWREaXJlY3RvcnkpLFxuICAgICAgICBjb21wYXRpYmxlUnVudGltZXM6IFtMQU1CREFfUlVOVElNRV0sXG4gICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1lcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLmxhbWJkYUxheWVyID0gc2hhcmVkTGF5ZXI7XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBhdXRob3JpemVyIHRvIGJlIHVzZWQgaW4gc3Vic2VxdWVudCBNZXRob2RzXG4gICAgbGV0IHRva2VuQXV0aG9yaXplcjogYXBpZ2F0ZXdheS5JQXV0aG9yaXplcjtcbiAgICBpZiAodXNlQXV0aG9yaXplckxhbWJkYSkge1xuICAgICAgY29uc3QgZnVsbEF1dGhvcml6ZXJEaXJlY3RvcnkgPSBgJHtzb3VyY2VEaXJlY3Rvcnl9LyR7YXV0aG9yaXplckRpcmVjdG9yeX1gO1xuXG4gICAgICBjb25zdCBhdXRob3JpemVyTGFtYmRhUHJvcHMgPSBidW5kbGVMYW1iZGFQcm9wcyhcbiAgICAgICAgZnVsbEF1dGhvcml6ZXJEaXJlY3RvcnksXG4gICAgICAgIGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmF0aW9uLFxuICAgICAgICBzaGFyZWRMYXllclxuICAgICAgKTtcblxuICAgICAgY29uc3QgYXV0aG9yaXplckxhbWJkYSA9IG5ldyBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbih0aGlzLCBcImF1dGhvcml6ZXItbGFtYmRhXCIsIGF1dGhvcml6ZXJMYW1iZGFQcm9wcyk7XG4gICAgICB0aGlzLmF1dGhvcml6ZXJMYW1iZGEgPSBhdXRob3JpemVyTGFtYmRhO1xuXG4gICAgICBjb25zdCBidW5kbGVkVG9rZW5BdXRoQ29uZmlnID0ge1xuICAgICAgICBoYW5kbGVyOiBhdXRob3JpemVyTGFtYmRhLFxuICAgICAgICByZXN1bHRzQ2FjaGVUdGw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDM2MDApLFxuICAgICAgICAuLi50b2tlbkF1dGhvcml6ZXJDb25maWd1cmF0aW9uXG4gICAgICB9O1xuICAgICAgdG9rZW5BdXRob3JpemVyID0gbmV3IGFwaWdhdGV3YXkuVG9rZW5BdXRob3JpemVyKHRoaXMsIFwidG9rZW4tYXV0aG9yaXplclwiLCBidW5kbGVkVG9rZW5BdXRoQ29uZmlnKTtcbiAgICAgIHRoaXMuYXV0aG9yaXplciA9IHRva2VuQXV0aG9yaXplcjtcbiAgICB9XG5cbiAgICAvLyBUaW1lIHRvIHN0YXJ0IHdhbGtpbmcgdGhlIGRpcmVjdG9yaWVzXG4gICAgY29uc3Qgcm9vdCA9IHNvdXJjZURpcmVjdG9yeTtcbiAgICBjb25zdCB2ZXJicyA9IFtcImdldFwiLCBcInBvc3RcIiwgXCJwdXRcIiwgXCJkZWxldGVcIl07XG4gICAgY29uc3QgZ3JhcGg6IEZTR3JhcGggPSB7fTtcbiAgICBjb25zdCBsYW1iZGFzQnlQYXRoOiBMYW1iZGFzQnlQYXRoID0ge307XG5cbiAgICAvLyBJbml0aWFsaXplIHdpdGggcm9vdFxuICAgIGdyYXBoW1wiL1wiXSA9IHtcbiAgICAgIHJlc291cmNlOiBnYXRld2F5LnJvb3QsXG4gICAgICBwYXRoOiByb290LFxuICAgICAgcGF0aHM6IFtdLFxuICAgICAgdmVyYnM6IFtdXG4gICAgfTtcbiAgICAvLyBGaXJzdCBlbGVtZW50IGluIHR1cGxlIGlzIGRpcmVjdG9yeSBwYXRoLCBzZWNvbmQgaXMgQVBJIHBhdGhcbiAgICBjb25zdCBub2RlczogW3N0cmluZywgc3RyaW5nXVtdID0gW1tyb290LCBcIi9cIl1dO1xuXG4gICAgLy8gQkZTIHRoYXQgY3JlYXRlcyBBUEkgR2F0ZXdheSBzdHJ1Y3R1cmUgdXNpbmcgYWRkTWV0aG9kXG4gICAgd2hpbGUgKG5vZGVzLmxlbmd0aCkge1xuICAgICAgLy8gVGhlIGB8fCBbJ3R5cGUnLCAnc2NyaXB0J11gIHBpZWNlIGlzIG5lZWRlZCBvciBUUyB0aHJvd3MgYSBmaXRcbiAgICAgIGNvbnN0IFtkaXJlY3RvcnlQYXRoLCBhcGlQYXRoXSA9IG5vZGVzLnNoaWZ0KCkgfHwgW1widHlwZVwiLCBcInNjcmlwdFwiXTtcbiAgICAgIGNvbnN0IGNoaWxkcmVuOiBhbnlbXSA9IGdldERpcmVjdG9yeUNoaWxkcmVuKGRpcmVjdG9yeVBhdGgpO1xuXG4gICAgICAvLyBGb3IgZGVidWdnaW5nIHB1cnBvc2VzXG4gICAgICAvLyBjb25zb2xlLmxvZyhgJHthcGlQYXRofSdzIGNoaWxkcmVuIGFyZTogJHtjaGlsZHJlbn1gKTtcblxuICAgICAgLy8gRG9uJ3QgaGF2ZSB0byB3b3JyeSBhYm91dCBwcmV2aW91c2x5IHZpc2l0ZWQgbm9kZXNcbiAgICAgIC8vIHNpbmNlIHRoaXMgaXMgYSBmaWxlIHN0cnVjdHVyZVxuICAgICAgLy8gLi4udW5sZXNzIHRoZXJlIGFyZSBzeW1saW5rcz8gSGF2ZW4ndCBydW4gaW50byB0aGF0XG4gICAgICBjaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4ge1xuICAgICAgICBjb25zdCBuZXdEaXJlY3RvcnlQYXRoID0gYCR7ZGlyZWN0b3J5UGF0aH0vJHtjaGlsZH1gO1xuICAgICAgICAvLyBJZiB3ZSdyZSBvbiB0aGUgcm9vdCBwYXRoLCBkb24ndCBzZXBhcmF0ZSB3aXRoIGEgc2xhc2ggKC8pXG4gICAgICAgIC8vICAgYmVjYXVzZSBpdCBlbmRzIHVwIGxvb2tpbmcgbGlrZSAvL2NoaWxkLXBhdGhcbiAgICAgICAgY29uc3QgbmV3QXBpUGF0aCA9IGFwaVBhdGggPT09IFwiL1wiID8gYC8ke2NoaWxkfWAgOiBgJHthcGlQYXRofS8ke2NoaWxkfWA7XG5cbiAgICAgICAgaWYgKHZlcmJzLmluY2x1ZGVzKGNoaWxkKSkge1xuICAgICAgICAgIC8vIElmIGRpcmVjdG9yeSBpcyBhIHZlcmIsIHdlIGRvbid0IHRyYXZlcnNlIGl0IGFueW1vcmVcbiAgICAgICAgICAvLyAgIGFuZCBuZWVkIHRvIGNyZWF0ZSBhbiBBUEkgR2F0ZXdheSBtZXRob2QgYW5kIExhbWJkYVxuICAgICAgICAgIGNvbnN0IHVzZXJMYW1iZGFDb25maWd1cmF0aW9uID0gZ2V0TGFtYmRhQ29uZmlnKG5ld0FwaVBhdGgpO1xuICAgICAgICAgIGNvbnN0IGxhbWJkYVByb3BzID0gYnVuZGxlTGFtYmRhUHJvcHMobmV3RGlyZWN0b3J5UGF0aCwgdXNlckxhbWJkYUNvbmZpZ3VyYXRpb24sIHNoYXJlZExheWVyKTtcbiAgICAgICAgICBjb25zdCBuZXdMYW1iZGEgPSBuZXcgbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb24odGhpcywgbmV3RGlyZWN0b3J5UGF0aCwgbGFtYmRhUHJvcHMpO1xuXG4gICAgICAgICAgLy8gUHVsbCBvdXQgdXNlQXV0aG9yaXplckxhbWJkYSB2YWx1ZSBhbmQgdGhlIHR3ZWFrZWQgbW9kZWwgdmFsdWVzXG4gICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgdXNlQXV0aG9yaXplckxhbWJkYTogYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyZWQgPSBmYWxzZSxcbiAgICAgICAgICAgIHJlcXVlc3RNb2RlbHM6IGNyb3dSZXF1ZXN0TW9kZWxzLFxuICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiBjcm93TWV0aG9kUmVzcG9uc2VzLFxuICAgICAgICAgICAgcmVxdWVzdFZhbGlkYXRvcjogcmVxdWVzdFZhbGlkYXRvclN0cmluZyxcbiAgICAgICAgICAgIC4uLnVzZXJNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgfSA9IG1ldGhvZENvbmZpZ3VyYXRpb25zW25ld0FwaVBhdGhdIHx8IHt9O1xuICAgICAgICAgIGxldCBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbjogYW55ID0ge1xuICAgICAgICAgICAgLi4udXNlck1ldGhvZENvbmZpZ3VyYXRpb25cbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgLy8gTWFwIG1vZGVsc1xuICAgICAgICAgIGNvbnN0IHJlcXVlc3RNb2RlbHM6IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbCB9ID0ge307XG4gICAgICAgICAgaWYgKGNyb3dSZXF1ZXN0TW9kZWxzKSB7XG4gICAgICAgICAgICBPYmplY3QuZW50cmllcyhjcm93UmVxdWVzdE1vZGVscykuZm9yRWFjaCgoW2NvbnRlbnRUeXBlLCBtb2RlbE5hbWVdKSA9PiB7XG4gICAgICAgICAgICAgIHJlcXVlc3RNb2RlbHNbY29udGVudFR5cGVdID0gY3JlYXRlZE1vZGVsc1ttb2RlbE5hbWVdO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgbWV0aG9kUmVzcG9uc2VzOiBhcGlnYXRld2F5Lk1ldGhvZFJlc3BvbnNlW10gPSBbXTtcbiAgICAgICAgICBpZiAoY3Jvd01ldGhvZFJlc3BvbnNlcyAmJiBjcm93TWV0aG9kUmVzcG9uc2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNyb3dNZXRob2RSZXNwb25zZXMuZm9yRWFjaCgoY3Jvd01ldGhvZFJlc3BvbnNlKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlTW9kZWxzOiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfSA9IHt9O1xuICAgICAgICAgICAgICBpZiAoY3Jvd01ldGhvZFJlc3BvbnNlLnJlc3BvbnNlTW9kZWxzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY3Jvd1Jlc3BvbnNlTW9kZWxzID0gY3Jvd01ldGhvZFJlc3BvbnNlLnJlc3BvbnNlTW9kZWxzO1xuICAgICAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGNyb3dSZXNwb25zZU1vZGVscykuZm9yRWFjaCgoW2NvbnRlbnRUeXBlLCBtb2RlbE5hbWVdKSA9PiB7XG4gICAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1tjb250ZW50VHlwZV0gPSBjcmVhdGVkTW9kZWxzW21vZGVsTmFtZV07XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCB7IHN0YXR1c0NvZGUsIHJlc3BvbnNlUGFyYW1ldGVycyB9ID0gY3Jvd01ldGhvZFJlc3BvbnNlO1xuICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgc3RhdHVzQ29kZSxcbiAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnMsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VNb2RlbHNcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBGaW5kIHJlcXVlc3QgdmFsaWRhdG9yXG4gICAgICAgICAgaWYgKHJlcXVlc3RWYWxpZGF0b3JTdHJpbmcgJiYgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzW3JlcXVlc3RWYWxpZGF0b3JTdHJpbmddKSB7XG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbi5yZXF1ZXN0VmFsaWRhdG9yID0gY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzW3JlcXVlc3RWYWxpZGF0b3JTdHJpbmddO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLnJlcXVlc3RNb2RlbHMgPSByZXF1ZXN0TW9kZWxzO1xuICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLm1ldGhvZFJlc3BvbnNlcyA9IG1ldGhvZFJlc3BvbnNlcztcbiAgICAgICAgICAvLyBJZiB0aGlzIG1ldGhvZCBzaG91bGQgYmUgYmVoaW5kIGFuIGF1dGhvcml6ZXIgTGFtYmRhXG4gICAgICAgICAgLy8gICBjb25zdHJ1Y3QgdGhlIG1ldGhvZENvbmZpZ3VyYXRpb24gb2JqZWN0IGFzIHN1Y2hcbiAgICAgICAgICBpZiAoYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyZWQgJiYgdXNlQXV0aG9yaXplckxhbWJkYSkge1xuICAgICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24uYXV0aG9yaXphdGlvblR5cGUgPSBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlLkNVU1RPTTtcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLmF1dGhvcml6ZXIgPSB0b2tlbkF1dGhvcml6ZXI7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgaW50ZWdyYXRpb25PcHRpb25zID0gbGFtYmRhSW50ZWdyYXRpb25PcHRpb25zW25ld0FwaVBhdGhdIHx8IHt9O1xuICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIGNoaWxkLnRvVXBwZXJDYXNlKCksXG4gICAgICAgICAgICBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihuZXdMYW1iZGEsIGludGVncmF0aW9uT3B0aW9ucyksXG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvblxuICAgICAgICAgICk7XG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0udmVyYnMucHVzaChjaGlsZCk7XG4gICAgICAgICAgbGFtYmRhc0J5UGF0aFtuZXdBcGlQYXRoXSA9IG5ld0xhbWJkYTtcbiAgICAgICAgfSBlbHNlIGlmIChTUEVDSUFMX0RJUkVDVE9SSUVTLmluY2x1ZGVzKGNoaWxkKSkge1xuICAgICAgICAgIC8vIFRoZSBzcGVjaWFsIGRpcmVjdG9yaWVzIHNob3VsZCBub3QgcmVzdWx0IGluIGFuIEFQSSBwYXRoXG4gICAgICAgICAgLy8gVGhpcyBtZWFucyB0aGUgQVBJIGFsc28gY2Fubm90IGhhdmUgYSByZXNvdXJjZSB3aXRoIHRoZVxuICAgICAgICAgIC8vICAgc2FtZSBuYW1lXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gSWYgZGlyZWN0b3J5IGlzIG5vdCBhIHZlcmIsIGNyZWF0ZSBuZXcgQVBJIEdhdGV3YXkgcmVzb3VyY2VcbiAgICAgICAgICAvLyAgIGZvciB1c2UgYnkgdmVyYiBkaXJlY3RvcnkgbGF0ZXJcblxuICAgICAgICAgIGNvbnN0IG5ld1Jlc291cmNlID0gZ3JhcGhbYXBpUGF0aF0ucmVzb3VyY2UucmVzb3VyY2VGb3JQYXRoKGNoaWxkKTtcblxuICAgICAgICAgIG5vZGVzLnB1c2goW25ld0RpcmVjdG9yeVBhdGgsIG5ld0FwaVBhdGhdKTtcblxuICAgICAgICAgIC8vIEFkZCBjaGlsZCB0byBwYXJlbnQncyBwYXRoc1xuICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnBhdGhzLnB1c2goY2hpbGQpO1xuXG4gICAgICAgICAgLy8gSW5pdGlhbGl6ZSBncmFwaCBub2RlIHRvIGluY2x1ZGUgY2hpbGRcbiAgICAgICAgICBncmFwaFtuZXdBcGlQYXRoXSA9IHtcbiAgICAgICAgICAgIHJlc291cmNlOiBuZXdSZXNvdXJjZSxcbiAgICAgICAgICAgIHBhdGg6IG5ld0RpcmVjdG9yeVBhdGgsXG4gICAgICAgICAgICBwYXRoczogW10sXG4gICAgICAgICAgICB2ZXJiczogW11cbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBGb3IgZGVidWdnaW5nIHB1cnBvc2VzXG4gICAgLy8gY29uc29sZS5sb2coZ3JhcGgpO1xuXG4gICAgLy8gRXhwb3NlIEFQSSBHYXRld2F5XG4gICAgdGhpcy5nYXRld2F5ID0gZ2F0ZXdheTtcbiAgICB0aGlzLmxhbWJkYUZ1bmN0aW9ucyA9IGxhbWJkYXNCeVBhdGg7XG4gICAgdGhpcy5tb2RlbHMgPSBjcmVhdGVkTW9kZWxzO1xuICAgIHRoaXMucmVxdWVzdFZhbGlkYXRvcnMgPSBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnM7XG4gIH1cbn1cbiJdfQ==