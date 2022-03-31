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
                    baseRoute += !baseRoute ? `/${segment}` : `${segment}`;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBdUM7QUFDdkMsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBRTdDOztHQUVHO0FBQ0gsZ0NBQWdDOzs7O0FBZ0doQyxNQUFhLE9BQVEsU0FBUSxzQkFBUzs7OztJQVdwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsb0JBQW9CO1FBQ3BCLE1BQU0sRUFDSixlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsUUFBUSxFQUMxQixtQkFBbUIsR0FBRyxLQUFLLEVBQzNCLG1CQUFtQixHQUFHLFlBQVksRUFDbEMsNkJBQTZCLEdBQUcsRUFBRSxFQUNsQyw0QkFBNEIsR0FBRyxFQUFFLEVBQ2pDLFlBQVksR0FBRyxLQUFLLEVBQ3BCLFlBQVksR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFDMUMsdUJBQXVCLEdBQUcsRUFBRSxFQUM1QixjQUFjLEdBQUcsVUFBVSxFQUMzQixvQkFBb0IsR0FBRyxFQUFFLEVBQ3pCLHdCQUF3QixHQUFHLEVBQUUsRUFDN0IsTUFBTSxHQUFHLEVBQUUsRUFDWCxpQkFBaUIsR0FBRyxFQUFFLEVBQ3RCLG9CQUFvQixHQUFHLEVBQUUsRUFDMUIsR0FBRyxLQUFLLENBQUM7UUFFVix5QkFBeUI7UUFDekIsTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUM7UUFDbEQsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLGVBQWUsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRW5FLG9DQUFvQztRQUVwQyxtRUFBbUU7UUFDbkUsU0FBUyxpQkFBaUIsQ0FDeEIsUUFBZ0IsRUFDaEIsaUJBQWtELEVBQ2xE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QyxDQUFDO1NBQ0o7UUFFRCx5QkFBeUI7UUFDekIsc0JBQXNCO1FBRXRCLHFCQUFxQjtRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUN2QixJQUFJLENBQUMsZUFBZSxHQUFHLGFBQWEsQ0FBQztRQUNyQyxJQUFJLENBQUMsTUFBTSxHQUFHLGFBQWEsQ0FBQztRQUM1QixJQUFJLENBQUMsaUJBQWlCLEdBQUcsd0JBQXdCLENBQUM7SUFDcEQsQ0FBQzs7QUEvVUgsMEJBZ1ZDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbm9kZV9sYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzXCI7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcblxuLyoqXG4gKiBGb3IgY29weWluZyBzaGFyZWQgY29kZSB0byBhbGwgcGF0aHNcbiAqL1xuaW1wb3J0ICogYXMgZnNlIGZyb20gXCJmcy1leHRyYVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIExhbWJkYXNCeVBhdGgge1xuICBbcGF0aDogc3RyaW5nXTogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd0xhbWJkYUNvbmZpZ3VyYXRpb25zIHtcbiAgW2xhbWJkYUJ5UGF0aDogc3RyaW5nXTogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wcztcbn1cblxuLy8gU2FtZSBhcyBNb2RlbE9wdGlvbnMgYnV0IG1vZGVsTmFtZSBpcyByZXF1aXJlZCAodXNlZCBhcyBJRClcbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01vZGVsT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHNjaGVtYTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hO1xuICByZWFkb25seSBtb2RlbE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGVudFR5cGU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xufVxuXG4vLyBTYW1lIGFzIFJlcXVlc3RWYWxpZGF0b3JPcHRpb25zIGJ1dCByZXF1ZXN0VmFsaWRhdG9yTmFtZSBpcyByZXF1aXJlZCAodXNlZCBhcyBJRClcbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd1JlcXVlc3RWYWxpZGF0b3JPcHRpb25zIHtcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvck5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgdmFsaWRhdGVSZXF1ZXN0Qm9keT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHZhbGlkYXRlUmVxdWVzdFBhcmFtZXRlcnM/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RSZXNwb25zZSB7XG4gIHJlYWRvbmx5IHN0YXR1c0NvZGU6IHN0cmluZztcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSBtb2RlbE5hbWVcbiAgcmVhZG9ubHkgcmVzcG9uc2VNb2RlbHM/OiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIHJlYWRvbmx5IHJlc3BvbnNlUGFyYW1ldGVycz86IHsgW3BhcmFtOiBzdHJpbmddOiBib29sZWFuIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb24ge1xuICAvLyBSZWRlZmluaW5nIE1ldGhvZE9wdGlvbnMgc2luY2UgT21pdCBpcyBub3Qgc3VwcG9ydGVkXG4gIHJlYWRvbmx5IGFwaUtleVJlcXVpcmVkPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNjb3Blcz86IHN0cmluZ1tdO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uVHlwZT86IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGU7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICByZWFkb25seSBtZXRob2RSZXNwb25zZXM/OiBDcm93TWV0aG9kUmVzcG9uc2VbXTtcbiAgcmVhZG9ubHkgb3BlcmF0aW9uTmFtZT86IHN0cmluZztcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSBtb2RlbE5hbWVcbiAgcmVhZG9ubHkgcmVxdWVzdE1vZGVscz86IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgcmVhZG9ubHkgcmVxdWVzdFBhcmFtZXRlcnM/OiB7IFtwYXJhbTogc3RyaW5nXTogYm9vbGVhbiB9O1xuICAvLyBUYWtlcyBhIHN0cmluZyB3aGljaCBpcyBtYXRjaGVkIHdpdGggdGhlIHJlcXVlc3RWYWxpZGF0b3JOYW1lXG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3I/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JPcHRpb25zPzogYXBpZ2F0ZXdheS5SZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucztcbiAgcmVhZG9ubHkgdXNlQXV0aG9yaXplckxhbWJkYT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb25zIHtcbiAgLy8gbWV0aG9kQnlQYXRoIHNob3VsZCBiZSBsYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgW21ldGhvZEJ5UGF0aDogc3RyaW5nXTogQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd0FwaVByb3BzIHtcbiAgcmVhZG9ubHkgc291cmNlRGlyZWN0b3J5Pzogc3RyaW5nO1xuICByZWFkb25seSBzaGFyZWREaXJlY3Rvcnk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHVzZUF1dGhvcml6ZXJMYW1iZGE/OiBib29sZWFuO1xuICByZWFkb25seSBhdXRob3JpemVyRGlyZWN0b3J5Pzogc3RyaW5nO1xuICAvLyBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbiBzaG91bGQgYmUgbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmF0aW9uPzogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wcyB8IGFueTtcbiAgLy8gYXV0aG9yaXplckNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGFwaWdhdGV3YXkuVG9rZW5BdXRob3JpemVyUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIHJlYWRvbmx5IHRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb24/OiBhcGlnYXRld2F5LlRva2VuQXV0aG9yaXplclByb3BzIHwgYW55O1xuICByZWFkb25seSBjcmVhdGVBcGlLZXk/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIC8vIGFwaUdhdHdheUNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGFwaWdhdGV3YXkuTGFtYmRhUmVzdEFwaVByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSBhcGlHYXRld2F5Q29uZmlndXJhdGlvbj86IGFwaWdhdGV3YXkuUmVzdEFwaVByb3BzIHwgYW55O1xuICByZWFkb25seSBhcGlHYXRld2F5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgbGFtYmRhQ29uZmlndXJhdGlvbnM/OiBDcm93TGFtYmRhQ29uZmlndXJhdGlvbnM7XG4gIHJlYWRvbmx5IGxhbWJkYUludGVncmF0aW9uT3B0aW9ucz86IHtcbiAgICBbbGFtYmRhUGF0aDogc3RyaW5nXTogYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnM7XG4gIH07XG4gIHJlYWRvbmx5IG1vZGVscz86IENyb3dNb2RlbE9wdGlvbnNbXTtcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvcnM/OiBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnNbXTtcbiAgcmVhZG9ubHkgbWV0aG9kQ29uZmlndXJhdGlvbnM/OiBDcm93TWV0aG9kQ29uZmlndXJhdGlvbnM7XG59XG5cbmludGVyZmFjZSBGU0dyYXBoTm9kZSB7XG4gIHJlc291cmNlOiBhcGlnYXRld2F5LklSZXNvdXJjZTtcbiAgcGF0aDogc3RyaW5nO1xuICBwYXRoczogc3RyaW5nW107XG4gIHZlcmJzOiBzdHJpbmdbXTtcbn1cblxuaW50ZXJmYWNlIEZTR3JhcGgge1xuICBbcGF0aDogc3RyaW5nXTogRlNHcmFwaE5vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBDcm93QXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIGdhdGV3YXkhOiBhcGlnYXRld2F5LlJlc3RBcGk7XG4gIHB1YmxpYyB1c2FnZVBsYW4hOiBhcGlnYXRld2F5LlVzYWdlUGxhbjtcbiAgcHVibGljIGF1dGhvcml6ZXIhOiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICBwdWJsaWMgYXV0aG9yaXplckxhbWJkYSE6IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uO1xuICBwdWJsaWMgbGFtYmRhTGF5ZXIhOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkO1xuICBwdWJsaWMgbGFtYmRhRnVuY3Rpb25zITogTGFtYmRhc0J5UGF0aDtcbiAgcHVibGljIG1vZGVscyE6IHsgW21vZGVsTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfTtcbiAgcHVibGljIHJlcXVlc3RWYWxpZGF0b3JzITogeyBbcmVxdWVzdFZhbGlkYXRvcnNOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklSZXF1ZXN0VmFsaWRhdG9yIH07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBDcm93QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gUHVsbGluZyBvdXQgcHJvcHNcbiAgICBjb25zdCB7XG4gICAgICBzb3VyY2VEaXJlY3RvcnkgPSBcInNyY1wiLFxuICAgICAgc2hhcmVkRGlyZWN0b3J5ID0gXCJzaGFyZWRcIixcbiAgICAgIHVzZUF1dGhvcml6ZXJMYW1iZGEgPSBmYWxzZSxcbiAgICAgIGF1dGhvcml6ZXJEaXJlY3RvcnkgPSBcImF1dGhvcml6ZXJcIixcbiAgICAgIGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmF0aW9uID0ge30sXG4gICAgICB0b2tlbkF1dGhvcml6ZXJDb25maWd1cmF0aW9uID0ge30sXG4gICAgICBjcmVhdGVBcGlLZXkgPSBmYWxzZSxcbiAgICAgIGxvZ1JldGVudGlvbiA9IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIGFwaUdhdGV3YXlDb25maWd1cmF0aW9uID0ge30sXG4gICAgICBhcGlHYXRld2F5TmFtZSA9IFwiY3Jvdy1hcGlcIixcbiAgICAgIGxhbWJkYUNvbmZpZ3VyYXRpb25zID0ge30sXG4gICAgICBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnMgPSB7fSxcbiAgICAgIG1vZGVscyA9IFtdLFxuICAgICAgcmVxdWVzdFZhbGlkYXRvcnMgPSBbXSxcbiAgICAgIG1ldGhvZENvbmZpZ3VyYXRpb25zID0ge31cbiAgICB9ID0gcHJvcHM7XG5cbiAgICAvLyBJbml0aWFsaXppbmcgY29uc3RhbnRzXG4gICAgY29uc3QgTEFNQkRBX1JVTlRJTUUgPSBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWDtcbiAgICBjb25zdCBTUEVDSUFMX0RJUkVDVE9SSUVTID0gW3NoYXJlZERpcmVjdG9yeSwgYXV0aG9yaXplckRpcmVjdG9yeV07XG5cbiAgICAvLyBIZWxwZXJzIGZ1bmN0aW9ucyBmb3IgY29uc3RydWN0b3JcblxuICAgIC8vIFByZXBhcmVzIGRlZmF1bHQgTGFtYmRhIHByb3BzIGFuZCBvdmVycmlkZXMgdGhlbSB3aXRoIHVzZXIgaW5wdXRcbiAgICBmdW5jdGlvbiBidW5kbGVMYW1iZGFQcm9wcyhcbiAgICAgIGNvZGVQYXRoOiBzdHJpbmcsXG4gICAgICB1c2VyQ29uZmlndXJhdGlvbjogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wcyxcbiAgICAgIHNoYXJlZExheWVyOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkXG4gICAgKSB7XG4gICAgICBsZXQgbGF5ZXJzO1xuICAgICAgaWYgKHNoYXJlZExheWVyKSB7XG4gICAgICAgIGNvbnN0IHsgbGF5ZXJzOiB1c2VyTGF5ZXJzID0gW10gfSA9IHVzZXJDb25maWd1cmF0aW9uO1xuICAgICAgICBsYXllcnMgPSBbc2hhcmVkTGF5ZXIsIC4uLnVzZXJMYXllcnNdO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkZWZhdWx0UHJvcHMgPSB7XG4gICAgICAgIHJ1bnRpbWU6IExBTUJEQV9SVU5USU1FLFxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoY29kZVBhdGgpLFxuICAgICAgICBlbnRyeTogYCR7Y29kZVBhdGh9L2luZGV4LmpzYCxcbiAgICAgICAgaGFuZGxlcjogXCJoYW5kbGVyXCIsXG4gICAgICAgIGxvZ1JldGVudGlvblxuICAgICAgfTtcblxuICAgICAgY29uc3QgbGFtYmRhUHJvcHMgPSB7XG4gICAgICAgIC4uLmRlZmF1bHRQcm9wcyxcbiAgICAgICAgLi4udXNlckNvbmZpZ3VyYXRpb24sIC8vIExldCB1c2VyIGNvbmZpZ3VyYXRpb24gb3ZlcnJpZGUgYW55dGhpbmcgZXhjZXB0IGxheWVyc1xuICAgICAgICBsYXllcnNcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiBsYW1iZGFQcm9wcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRMYW1iZGFDb25maWcobmV3QXBpUGF0aDogc3RyaW5nKSB7XG4gICAgICAvLyBpZiBkaXJlY3QgbWF0Y2ggcmV0dXJuIHJpZ2h0IGF3YXlcbiAgICAgIGlmIChsYW1iZGFDb25maWd1cmF0aW9uc1tuZXdBcGlQYXRoXSkge1xuICAgICAgICByZXR1cm4gbGFtYmRhQ29uZmlndXJhdGlvbnNbbmV3QXBpUGF0aF07XG4gICAgICB9XG5cbiAgICAgIC8vIGNoZWNrIGFsbCByb3V0ZSB3aWxkIGNhcmQgb3B0aW9ucyBmb3IgbWF0Y2hpbmcgY29uZmlnc1xuICAgICAgbGV0IGJhc2VSb3V0ZTogc3RyaW5nID0gXCJcIjtcbiAgICAgIGNvbnN0IG1hdGNoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBuZXdBcGlQYXRoXG4gICAgICAgIC5zcGxpdChcIi9cIilcbiAgICAgICAgLm1hcCgoc2VnbWVudCkgPT4ge1xuICAgICAgICAgIGlmIChzZWdtZW50KSB7XG4gICAgICAgICAgICBiYXNlUm91dGUgKz0gIWJhc2VSb3V0ZSA/IGAvJHtzZWdtZW50fWAgOiBgJHtzZWdtZW50fWA7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBgJHtiYXNlUm91dGV9LypgO1xuICAgICAgICB9KVxuICAgICAgICAuZmluZCgod2lsZGNhcmQpID0+ICEhbGFtYmRhQ29uZmlndXJhdGlvbnNbd2lsZGNhcmRdKTtcblxuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgIHJldHVybiBsYW1iZGFDb25maWd1cmF0aW9uc1ttYXRjaF07XG4gICAgICB9XG5cbiAgICAgIC8vIHJldHVybnMgZW1wdHkgY29uZmlnXG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgLy8gUmV0dXJucyBjaGlsZCBkaXJlY3RvcmllcyBnaXZlbiB0aGUgcGF0aCBvZiBhIHBhcmVudFxuICAgIGZ1bmN0aW9uIGdldERpcmVjdG9yeUNoaWxkcmVuKHBhcmVudERpcmVjdG9yeTogc3RyaW5nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkaXJlY3RvcmllcyA9IGZzZVxuICAgICAgICAgIC5yZWFkZGlyU3luYyhwYXJlbnREaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgICAgIC5maWx0ZXIoKGRpcmVudDogYW55KSA9PiBkaXJlbnQuaXNEaXJlY3RvcnkoKSlcbiAgICAgICAgICAubWFwKChkaXJlbnQ6IGFueSkgPT4gZGlyZW50Lm5hbWUpO1xuICAgICAgICByZXR1cm4gZGlyZWN0b3JpZXM7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBvbmx5IHRpbWUgSSBoYXZlIHJ1biBpbnRvIHRoaXMgd2FzIHdoZW4gdGhlIHNyYy8gZGlyZWN0b3J5XG4gICAgICAgICAqIHdhcyBlbXB0eS5cbiAgICAgICAgICogSWYgaXQgaXMgZW1wdHksIGxldCBDREsgdHJlZSB2YWxpZGF0aW9uIHRlbGwgdXNlciB0aGF0IHRoZVxuICAgICAgICAgKiBSRVNUIEFQSSBkb2VzIG5vdCBoYXZlIGFueSBtZXRob2RzLlxuICAgICAgICAgKi9cbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICAvLyBBUEkgR2F0ZXdheSBsb2cgZ3JvdXBcbiAgICBjb25zdCBnYXRld2F5TG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcImFwaS1hY2Nlc3MtbG9nc1wiLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFS1xuICAgIH0pO1xuXG4gICAgLy8gVGhlIEFQSSBHYXRld2F5IGl0c2VsZlxuICAgIGNvbnN0IGdhdGV3YXkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsIGFwaUdhdGV3YXlOYW1lLCB7XG4gICAgICBkZXBsb3k6IHRydWUsXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIGxvZ2dpbmdMZXZlbDogYXBpZ2F0ZXdheS5NZXRob2RMb2dnaW5nTGV2ZWwuRVJST1IsXG4gICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBuZXcgYXBpZ2F0ZXdheS5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGdhdGV3YXlMb2dHcm91cClcbiAgICAgIH0sXG4gICAgICBhcGlLZXlTb3VyY2VUeXBlOiBjcmVhdGVBcGlLZXkgPyBhcGlnYXRld2F5LkFwaUtleVNvdXJjZVR5cGUuSEVBREVSIDogdW5kZWZpbmVkLFxuICAgICAgLi4uYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb25cbiAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZWRNb2RlbHM6IHsgW21vZGVsTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfSA9IHt9O1xuICAgIG1vZGVscy5mb3JFYWNoKChtb2RlbDogQ3Jvd01vZGVsT3B0aW9ucykgPT4ge1xuICAgICAgLy8gbW9kZWxOYW1lIGlzIHVzZWQgYXMgSUQgYW5kIGNhbiBub3cgYmUgdXNlZCBmb3IgcmVmZXJlbmNpbmcgbW9kZWwgaW4gbWV0aG9kIG9wdGlvbnNcbiAgICAgIGNyZWF0ZWRNb2RlbHNbbW9kZWwubW9kZWxOYW1lXSA9IGdhdGV3YXkuYWRkTW9kZWwobW9kZWwubW9kZWxOYW1lLCBtb2RlbCk7XG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzOiB7IFtyZXF1ZXN0VmFsaWRhdG9yc05hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSVJlcXVlc3RWYWxpZGF0b3IgfSA9IHt9O1xuICAgIHJlcXVlc3RWYWxpZGF0b3JzLmZvckVhY2goKHJlcXVlc3RWYWxpZGF0b3I6IENyb3dSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucykgPT4ge1xuICAgICAgLy8gcmVxdWVzdFZhbGlkYXRvck5hbWUgaXMgdXNlZCBhcyBJRCBhbmQgY2FuIG5vdyBiZSB1c2VkIGZvciByZWZlcmVuY2luZyBtb2RlbCBpbiBtZXRob2Qgb3B0aW9uc1xuICAgICAgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzW3JlcXVlc3RWYWxpZGF0b3IucmVxdWVzdFZhbGlkYXRvck5hbWVdID0gZ2F0ZXdheS5hZGRSZXF1ZXN0VmFsaWRhdG9yKFxuICAgICAgICByZXF1ZXN0VmFsaWRhdG9yLnJlcXVlc3RWYWxpZGF0b3JOYW1lLFxuICAgICAgICByZXF1ZXN0VmFsaWRhdG9yXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIEFQSSBrZXkgaWYgZGVzaXJlZFxuICAgIGlmIChjcmVhdGVBcGlLZXkpIHtcbiAgICAgIGNvbnN0IGFwaUtleSA9IGdhdGV3YXkuYWRkQXBpS2V5KFwiYXBpLWtleVwiKTtcbiAgICAgIGNvbnN0IHVzYWdlUGxhbiA9IG5ldyBhcGlnYXRld2F5LlVzYWdlUGxhbih0aGlzLCBcInVzYWdlLXBsYW5cIiwge1xuICAgICAgICB0aHJvdHRsZToge1xuICAgICAgICAgIGJ1cnN0TGltaXQ6IDUwMDAsXG4gICAgICAgICAgcmF0ZUxpbWl0OiAxMDAwMFxuICAgICAgICB9LFxuICAgICAgICBhcGlTdGFnZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhcGk6IGdhdGV3YXksXG4gICAgICAgICAgICBzdGFnZTogZ2F0ZXdheS5kZXBsb3ltZW50U3RhZ2VcbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0pO1xuICAgICAgdXNhZ2VQbGFuLmFkZEFwaUtleShhcGlLZXkpO1xuICAgICAgdGhpcy51c2FnZVBsYW4gPSB1c2FnZVBsYW47XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBsYXllciBvdXQgb2Ygc2hhcmVkIGRpcmVjdG9yeSBpZiBpdCBleGlzdHNcbiAgICBjb25zdCBzb3VyY2VTaGFyZWREaXJlY3RvcnkgPSBgJHtzb3VyY2VEaXJlY3Rvcnl9LyR7c2hhcmVkRGlyZWN0b3J5fWA7XG4gICAgbGV0IHNoYXJlZExheWVyOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkO1xuICAgIGlmIChmc2UuZXhpc3RzU3luYyhzb3VyY2VTaGFyZWREaXJlY3RvcnkpKSB7XG4gICAgICBzaGFyZWRMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsIFwic2hhcmVkLWxheWVyXCIsIHtcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHNvdXJjZVNoYXJlZERpcmVjdG9yeSksXG4gICAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW0xBTUJEQV9SVU5USU1FXSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMubGFtYmRhTGF5ZXIgPSBzaGFyZWRMYXllcjtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGF1dGhvcml6ZXIgdG8gYmUgdXNlZCBpbiBzdWJzZXF1ZW50IE1ldGhvZHNcbiAgICBsZXQgdG9rZW5BdXRob3JpemVyOiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICAgIGlmICh1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICBjb25zdCBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSA9IGAke3NvdXJjZURpcmVjdG9yeX0vJHthdXRob3JpemVyRGlyZWN0b3J5fWA7XG5cbiAgICAgIGNvbnN0IGF1dGhvcml6ZXJMYW1iZGFQcm9wcyA9IGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgICBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSxcbiAgICAgICAgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24sXG4gICAgICAgIHNoYXJlZExheWVyXG4gICAgICApO1xuXG4gICAgICBjb25zdCBhdXRob3JpemVyTGFtYmRhID0gbmV3IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uKHRoaXMsIFwiYXV0aG9yaXplci1sYW1iZGFcIiwgYXV0aG9yaXplckxhbWJkYVByb3BzKTtcbiAgICAgIHRoaXMuYXV0aG9yaXplckxhbWJkYSA9IGF1dGhvcml6ZXJMYW1iZGE7XG5cbiAgICAgIGNvbnN0IGJ1bmRsZWRUb2tlbkF1dGhDb25maWcgPSB7XG4gICAgICAgIGhhbmRsZXI6IGF1dGhvcml6ZXJMYW1iZGEsXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzYwMCksXG4gICAgICAgIC4uLnRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb25cbiAgICAgIH07XG4gICAgICB0b2tlbkF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXIodGhpcywgXCJ0b2tlbi1hdXRob3JpemVyXCIsIGJ1bmRsZWRUb2tlbkF1dGhDb25maWcpO1xuICAgICAgdGhpcy5hdXRob3JpemVyID0gdG9rZW5BdXRob3JpemVyO1xuICAgIH1cblxuICAgIC8vIFRpbWUgdG8gc3RhcnQgd2Fsa2luZyB0aGUgZGlyZWN0b3JpZXNcbiAgICBjb25zdCByb290ID0gc291cmNlRGlyZWN0b3J5O1xuICAgIGNvbnN0IHZlcmJzID0gW1wiZ2V0XCIsIFwicG9zdFwiLCBcInB1dFwiLCBcImRlbGV0ZVwiXTtcbiAgICBjb25zdCBncmFwaDogRlNHcmFwaCA9IHt9O1xuICAgIGNvbnN0IGxhbWJkYXNCeVBhdGg6IExhbWJkYXNCeVBhdGggPSB7fTtcblxuICAgIC8vIEluaXRpYWxpemUgd2l0aCByb290XG4gICAgZ3JhcGhbXCIvXCJdID0ge1xuICAgICAgcmVzb3VyY2U6IGdhdGV3YXkucm9vdCxcbiAgICAgIHBhdGg6IHJvb3QsXG4gICAgICBwYXRoczogW10sXG4gICAgICB2ZXJiczogW11cbiAgICB9O1xuICAgIC8vIEZpcnN0IGVsZW1lbnQgaW4gdHVwbGUgaXMgZGlyZWN0b3J5IHBhdGgsIHNlY29uZCBpcyBBUEkgcGF0aFxuICAgIGNvbnN0IG5vZGVzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbW3Jvb3QsIFwiL1wiXV07XG5cbiAgICAvLyBCRlMgdGhhdCBjcmVhdGVzIEFQSSBHYXRld2F5IHN0cnVjdHVyZSB1c2luZyBhZGRNZXRob2RcbiAgICB3aGlsZSAobm9kZXMubGVuZ3RoKSB7XG4gICAgICAvLyBUaGUgYHx8IFsndHlwZScsICdzY3JpcHQnXWAgcGllY2UgaXMgbmVlZGVkIG9yIFRTIHRocm93cyBhIGZpdFxuICAgICAgY29uc3QgW2RpcmVjdG9yeVBhdGgsIGFwaVBhdGhdID0gbm9kZXMuc2hpZnQoKSB8fCBbXCJ0eXBlXCIsIFwic2NyaXB0XCJdO1xuICAgICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gZ2V0RGlyZWN0b3J5Q2hpbGRyZW4oZGlyZWN0b3J5UGF0aCk7XG5cbiAgICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAgIC8vIGNvbnNvbGUubG9nKGAke2FwaVBhdGh9J3MgY2hpbGRyZW4gYXJlOiAke2NoaWxkcmVufWApO1xuXG4gICAgICAvLyBEb24ndCBoYXZlIHRvIHdvcnJ5IGFib3V0IHByZXZpb3VzbHkgdmlzaXRlZCBub2Rlc1xuICAgICAgLy8gc2luY2UgdGhpcyBpcyBhIGZpbGUgc3RydWN0dXJlXG4gICAgICAvLyAuLi51bmxlc3MgdGhlcmUgYXJlIHN5bWxpbmtzPyBIYXZlbid0IHJ1biBpbnRvIHRoYXRcbiAgICAgIGNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB7XG4gICAgICAgIGNvbnN0IG5ld0RpcmVjdG9yeVBhdGggPSBgJHtkaXJlY3RvcnlQYXRofS8ke2NoaWxkfWA7XG4gICAgICAgIC8vIElmIHdlJ3JlIG9uIHRoZSByb290IHBhdGgsIGRvbid0IHNlcGFyYXRlIHdpdGggYSBzbGFzaCAoLylcbiAgICAgICAgLy8gICBiZWNhdXNlIGl0IGVuZHMgdXAgbG9va2luZyBsaWtlIC8vY2hpbGQtcGF0aFxuICAgICAgICBjb25zdCBuZXdBcGlQYXRoID0gYXBpUGF0aCA9PT0gXCIvXCIgPyBgLyR7Y2hpbGR9YCA6IGAke2FwaVBhdGh9LyR7Y2hpbGR9YDtcblxuICAgICAgICBpZiAodmVyYnMuaW5jbHVkZXMoY2hpbGQpKSB7XG4gICAgICAgICAgLy8gSWYgZGlyZWN0b3J5IGlzIGEgdmVyYiwgd2UgZG9uJ3QgdHJhdmVyc2UgaXQgYW55bW9yZVxuICAgICAgICAgIC8vICAgYW5kIG5lZWQgdG8gY3JlYXRlIGFuIEFQSSBHYXRld2F5IG1ldGhvZCBhbmQgTGFtYmRhXG4gICAgICAgICAgY29uc3QgdXNlckxhbWJkYUNvbmZpZ3VyYXRpb24gPSBnZXRMYW1iZGFDb25maWcobmV3QXBpUGF0aCk7XG4gICAgICAgICAgY29uc3QgbGFtYmRhUHJvcHMgPSBidW5kbGVMYW1iZGFQcm9wcyhuZXdEaXJlY3RvcnlQYXRoLCB1c2VyTGFtYmRhQ29uZmlndXJhdGlvbiwgc2hhcmVkTGF5ZXIpO1xuICAgICAgICAgIGNvbnN0IG5ld0xhbWJkYSA9IG5ldyBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbih0aGlzLCBuZXdEaXJlY3RvcnlQYXRoLCBsYW1iZGFQcm9wcyk7XG5cbiAgICAgICAgICAvLyBQdWxsIG91dCB1c2VBdXRob3JpemVyTGFtYmRhIHZhbHVlIGFuZCB0aGUgdHdlYWtlZCBtb2RlbCB2YWx1ZXNcbiAgICAgICAgICBjb25zdCB7XG4gICAgICAgICAgICB1c2VBdXRob3JpemVyTGFtYmRhOiBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJlZCA9IGZhbHNlLFxuICAgICAgICAgICAgcmVxdWVzdE1vZGVsczogY3Jvd1JlcXVlc3RNb2RlbHMsXG4gICAgICAgICAgICBtZXRob2RSZXNwb25zZXM6IGNyb3dNZXRob2RSZXNwb25zZXMsXG4gICAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yOiByZXF1ZXN0VmFsaWRhdG9yU3RyaW5nLFxuICAgICAgICAgICAgLi4udXNlck1ldGhvZENvbmZpZ3VyYXRpb25cbiAgICAgICAgICB9ID0gbWV0aG9kQ29uZmlndXJhdGlvbnNbbmV3QXBpUGF0aF0gfHwge307XG4gICAgICAgICAgbGV0IGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uOiBhbnkgPSB7XG4gICAgICAgICAgICAuLi51c2VyTWV0aG9kQ29uZmlndXJhdGlvblxuICAgICAgICAgIH07XG5cbiAgICAgICAgICAvLyBNYXAgbW9kZWxzXG4gICAgICAgICAgY29uc3QgcmVxdWVzdE1vZGVsczogeyBbY29udGVudFR5cGU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH0gPSB7fTtcbiAgICAgICAgICBpZiAoY3Jvd1JlcXVlc3RNb2RlbHMpIHtcbiAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGNyb3dSZXF1ZXN0TW9kZWxzKS5mb3JFYWNoKChbY29udGVudFR5cGUsIG1vZGVsTmFtZV0pID0+IHtcbiAgICAgICAgICAgICAgcmVxdWVzdE1vZGVsc1tjb250ZW50VHlwZV0gPSBjcmVhdGVkTW9kZWxzW21vZGVsTmFtZV07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBtZXRob2RSZXNwb25zZXM6IGFwaWdhdGV3YXkuTWV0aG9kUmVzcG9uc2VbXSA9IFtdO1xuICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2VzICYmIGNyb3dNZXRob2RSZXNwb25zZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY3Jvd01ldGhvZFJlc3BvbnNlcy5mb3JFYWNoKChjcm93TWV0aG9kUmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VNb2RlbHM6IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbCB9ID0ge307XG4gICAgICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjcm93UmVzcG9uc2VNb2RlbHMgPSBjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHM7XG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoY3Jvd1Jlc3BvbnNlTW9kZWxzKS5mb3JFYWNoKChbY29udGVudFR5cGUsIG1vZGVsTmFtZV0pID0+IHtcbiAgICAgICAgICAgICAgICAgIHJlc3BvbnNlTW9kZWxzW2NvbnRlbnRUeXBlXSA9IGNyZWF0ZWRNb2RlbHNbbW9kZWxOYW1lXTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHsgc3RhdHVzQ29kZSwgcmVzcG9uc2VQYXJhbWV0ZXJzIH0gPSBjcm93TWV0aG9kUmVzcG9uc2U7XG4gICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVycyxcbiAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEZpbmQgcmVxdWVzdCB2YWxpZGF0b3JcbiAgICAgICAgICBpZiAocmVxdWVzdFZhbGlkYXRvclN0cmluZyAmJiBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ10pIHtcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLnJlcXVlc3RWYWxpZGF0b3IgPSBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ucmVxdWVzdE1vZGVscyA9IHJlcXVlc3RNb2RlbHM7XG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ubWV0aG9kUmVzcG9uc2VzID0gbWV0aG9kUmVzcG9uc2VzO1xuICAgICAgICAgIC8vIElmIHRoaXMgbWV0aG9kIHNob3VsZCBiZSBiZWhpbmQgYW4gYXV0aG9yaXplciBMYW1iZGFcbiAgICAgICAgICAvLyAgIGNvbnN0cnVjdCB0aGUgbWV0aG9kQ29uZmlndXJhdGlvbiBvYmplY3QgYXMgc3VjaFxuICAgICAgICAgIGlmIChhdXRob3JpemVyTGFtYmRhQ29uZmlndXJlZCAmJiB1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbi5hdXRob3JpemF0aW9uVHlwZSA9IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ1VTVE9NO1xuICAgICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24uYXV0aG9yaXplciA9IHRva2VuQXV0aG9yaXplcjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbk9wdGlvbnMgPSBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnNbbmV3QXBpUGF0aF0gfHwge307XG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucmVzb3VyY2UuYWRkTWV0aG9kKFxuICAgICAgICAgICAgY2hpbGQudG9VcHBlckNhc2UoKSxcbiAgICAgICAgICAgIG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKG5ld0xhbWJkYSwgaW50ZWdyYXRpb25PcHRpb25zKSxcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgKTtcbiAgICAgICAgICBncmFwaFthcGlQYXRoXS52ZXJicy5wdXNoKGNoaWxkKTtcbiAgICAgICAgICBsYW1iZGFzQnlQYXRoW25ld0FwaVBhdGhdID0gbmV3TGFtYmRhO1xuICAgICAgICB9IGVsc2UgaWYgKFNQRUNJQUxfRElSRUNUT1JJRVMuaW5jbHVkZXMoY2hpbGQpKSB7XG4gICAgICAgICAgLy8gVGhlIHNwZWNpYWwgZGlyZWN0b3JpZXMgc2hvdWxkIG5vdCByZXN1bHQgaW4gYW4gQVBJIHBhdGhcbiAgICAgICAgICAvLyBUaGlzIG1lYW5zIHRoZSBBUEkgYWxzbyBjYW5ub3QgaGF2ZSBhIHJlc291cmNlIHdpdGggdGhlXG4gICAgICAgICAgLy8gICBzYW1lIG5hbWVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBJZiBkaXJlY3RvcnkgaXMgbm90IGEgdmVyYiwgY3JlYXRlIG5ldyBBUEkgR2F0ZXdheSByZXNvdXJjZVxuICAgICAgICAgIC8vICAgZm9yIHVzZSBieSB2ZXJiIGRpcmVjdG9yeSBsYXRlclxuXG4gICAgICAgICAgY29uc3QgbmV3UmVzb3VyY2UgPSBncmFwaFthcGlQYXRoXS5yZXNvdXJjZS5yZXNvdXJjZUZvclBhdGgoY2hpbGQpO1xuXG4gICAgICAgICAgbm9kZXMucHVzaChbbmV3RGlyZWN0b3J5UGF0aCwgbmV3QXBpUGF0aF0pO1xuXG4gICAgICAgICAgLy8gQWRkIGNoaWxkIHRvIHBhcmVudCdzIHBhdGhzXG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucGF0aHMucHVzaChjaGlsZCk7XG5cbiAgICAgICAgICAvLyBJbml0aWFsaXplIGdyYXBoIG5vZGUgdG8gaW5jbHVkZSBjaGlsZFxuICAgICAgICAgIGdyYXBoW25ld0FwaVBhdGhdID0ge1xuICAgICAgICAgICAgcmVzb3VyY2U6IG5ld1Jlc291cmNlLFxuICAgICAgICAgICAgcGF0aDogbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIHBhdGhzOiBbXSxcbiAgICAgICAgICAgIHZlcmJzOiBbXVxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAvLyBjb25zb2xlLmxvZyhncmFwaCk7XG5cbiAgICAvLyBFeHBvc2UgQVBJIEdhdGV3YXlcbiAgICB0aGlzLmdhdGV3YXkgPSBnYXRld2F5O1xuICAgIHRoaXMubGFtYmRhRnVuY3Rpb25zID0gbGFtYmRhc0J5UGF0aDtcbiAgICB0aGlzLm1vZGVscyA9IGNyZWF0ZWRNb2RlbHM7XG4gICAgdGhpcy5yZXF1ZXN0VmFsaWRhdG9ycyA9IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9ycztcbiAgfVxufVxuIl19