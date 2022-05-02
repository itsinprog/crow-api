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
        const { sourceDirectory = "src", sharedDirectory = "shared", useAuthorizerLambda = false, authorizerDirectory = "authorizer", authorizerLambdaConfiguration = {}, tokenAuthorizerConfiguration = {}, createApiKey = false, logRetention = logs.RetentionDays.ONE_WEEK, apiGatewayConfiguration = {}, apiGatewayName = "crow-api", lambdaConfigurations = {}, lambdaIntegrationOptions = {}, models = [], requestValidators = [], methodConfigurations = {}, corsOptions = null } = props;
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
            apiKeySourceType: createApiKey
                ? apigateway.ApiKeySourceType.HEADER
                : undefined,
            defaultCorsPreflightOptions: corsOptions ? corsOptions : undefined,
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
            createdRequestValidators[requestValidator.requestValidatorName] =
                gateway.addRequestValidator(requestValidator.requestValidatorName, requestValidator);
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
                    if (requestValidatorString &&
                        createdRequestValidators[requestValidatorString]) {
                        bundledMethodConfiguration.requestValidator =
                            createdRequestValidators[requestValidatorString];
                    }
                    bundledMethodConfiguration.requestModels = requestModels;
                    bundledMethodConfiguration.methodResponses = methodResponses;
                    // If this method should be behind an authorizer Lambda
                    //   construct the methodConfiguration object as such
                    if (authorizerLambdaConfigured && useAuthorizerLambda) {
                        bundledMethodConfiguration.authorizationType =
                            apigateway.AuthorizationType.CUSTOM;
                        bundledMethodConfiguration.authorizer = tokenAuthorizer;
                    }
                    const integrationOptions = lambdaIntegrationOptions[newApiPath] || {};
                    graph[apiPath].resource.addMethod(child.toUpperCase(), new apigateway.LambdaIntegration(newLambda, integrationOptions), bundledMethodConfiguration);
                    if (corsOptions) {
                        graph[apiPath].resource.addCorsPreflight(corsOptions);
                    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBdUM7QUFDdkMsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBRTdDOztHQUVHO0FBQ0gsZ0NBQWdDOzs7O0FBb0doQyxNQUFhLE9BQVEsU0FBUSxzQkFBUzs7OztJQWFwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsb0JBQW9CO1FBQ3BCLE1BQU0sRUFDSixlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsUUFBUSxFQUMxQixtQkFBbUIsR0FBRyxLQUFLLEVBQzNCLG1CQUFtQixHQUFHLFlBQVksRUFDbEMsNkJBQTZCLEdBQUcsRUFBRSxFQUNsQyw0QkFBNEIsR0FBRyxFQUFFLEVBQ2pDLFlBQVksR0FBRyxLQUFLLEVBQ3BCLFlBQVksR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFDMUMsdUJBQXVCLEdBQUcsRUFBRSxFQUM1QixjQUFjLEdBQUcsVUFBVSxFQUMzQixvQkFBb0IsR0FBRyxFQUFFLEVBQ3pCLHdCQUF3QixHQUFHLEVBQUUsRUFDN0IsTUFBTSxHQUFHLEVBQUUsRUFDWCxpQkFBaUIsR0FBRyxFQUFFLEVBQ3RCLG9CQUFvQixHQUFHLEVBQUUsRUFDekIsV0FBVyxHQUFHLElBQUksRUFDbkIsR0FBRyxLQUFLLENBQUM7UUFFVix5QkFBeUI7UUFDekIsTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUM7UUFDbEQsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLGVBQWUsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRW5FLG9DQUFvQztRQUVwQyxtRUFBbUU7UUFDbkUsU0FBUyxpQkFBaUIsQ0FDeEIsUUFB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S0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHO3dCQUNsQixRQUFRLEVBQUUsV0FBVzt3QkFDckIsSUFBSSxFQUFFLGdCQUFnQjt3QkFDdEIsS0FBSyxFQUFFLEVBQUU7d0JBQ1QsS0FBSyxFQUFFLEVBQUU7cUJBQ1YsQ0FBQztpQkFDSDtZQUNILENBQUMsQ0FBQyxDQUFDO1NBQ0o7UUFFRCx5QkFBeUI7UUFDekIsc0JBQXNCO1FBRXRCLHFCQUFxQjtRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUN2QixJQUFJLENBQUMsZUFBZSxHQUFHLGFBQWEsQ0FBQztRQUNyQyxJQUFJLENBQUMsTUFBTSxHQUFHLGFBQWEsQ0FBQztRQUM1QixJQUFJLENBQUMsaUJBQWlCLEdBQUcsd0JBQXdCLENBQUM7SUFDcEQsQ0FBQzs7QUE1WEgsMEJBNlhDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbm9kZV9sYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzXCI7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcblxuLyoqXG4gKiBGb3IgY29weWluZyBzaGFyZWQgY29kZSB0byBhbGwgcGF0aHNcbiAqL1xuaW1wb3J0ICogYXMgZnNlIGZyb20gXCJmcy1leHRyYVwiO1xuaW1wb3J0IHsgQ29yc09wdGlvbnMgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcblxuZXhwb3J0IGludGVyZmFjZSBMYW1iZGFzQnlQYXRoIHtcbiAgW3BhdGg6IHN0cmluZ106IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dMYW1iZGFDb25maWd1cmF0aW9ucyB7XG4gIFtsYW1iZGFCeVBhdGg6IHN0cmluZ106IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHM7XG59XG5cbi8vIFNhbWUgYXMgTW9kZWxPcHRpb25zIGJ1dCBtb2RlbE5hbWUgaXMgcmVxdWlyZWQgKHVzZWQgYXMgSUQpXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNb2RlbE9wdGlvbnMge1xuICByZWFkb25seSBzY2hlbWE6IGFwaWdhdGV3YXkuSnNvblNjaGVtYTtcbiAgcmVhZG9ubHkgbW9kZWxOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbnRlbnRUeXBlPzogc3RyaW5nO1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcbn1cblxuLy8gU2FtZSBhcyBSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucyBidXQgcmVxdWVzdFZhbGlkYXRvck5hbWUgaXMgcmVxdWlyZWQgKHVzZWQgYXMgSUQpXG5leHBvcnQgaW50ZXJmYWNlIENyb3dSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHZhbGlkYXRlUmVxdWVzdEJvZHk/OiBib29sZWFuO1xuICByZWFkb25seSB2YWxpZGF0ZVJlcXVlc3RQYXJhbWV0ZXJzPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93TWV0aG9kUmVzcG9uc2Uge1xuICByZWFkb25seSBzdGF0dXNDb2RlOiBzdHJpbmc7XG4gIC8vIFRha2VzIGEgc3RyaW5nIHdoaWNoIGlzIG1hdGNoZWQgd2l0aCB0aGUgbW9kZWxOYW1lXG4gIHJlYWRvbmx5IHJlc3BvbnNlTW9kZWxzPzogeyBbY29udGVudFR5cGU6IHN0cmluZ106IHN0cmluZyB9O1xuICByZWFkb25seSByZXNwb25zZVBhcmFtZXRlcnM/OiB7IFtwYXJhbTogc3RyaW5nXTogYm9vbGVhbiB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RDb25maWd1cmF0aW9uIHtcbiAgLy8gUmVkZWZpbmluZyBNZXRob2RPcHRpb25zIHNpbmNlIE9taXQgaXMgbm90IHN1cHBvcnRlZFxuICByZWFkb25seSBhcGlLZXlSZXF1aXJlZD86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TY29wZXM/OiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlO1xuICByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ2F0ZXdheS5JQXV0aG9yaXplcjtcbiAgcmVhZG9ubHkgbWV0aG9kUmVzcG9uc2VzPzogQ3Jvd01ldGhvZFJlc3BvbnNlW107XG4gIHJlYWRvbmx5IG9wZXJhdGlvbk5hbWU/OiBzdHJpbmc7XG4gIC8vIFRha2VzIGEgc3RyaW5nIHdoaWNoIGlzIG1hdGNoZWQgd2l0aCB0aGUgbW9kZWxOYW1lXG4gIHJlYWRvbmx5IHJlcXVlc3RNb2RlbHM/OiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIHJlYWRvbmx5IHJlcXVlc3RQYXJhbWV0ZXJzPzogeyBbcGFyYW06IHN0cmluZ106IGJvb2xlYW4gfTtcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSByZXF1ZXN0VmFsaWRhdG9yTmFtZVxuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9yPzogc3RyaW5nO1xuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucz86IGFwaWdhdGV3YXkuUmVxdWVzdFZhbGlkYXRvck9wdGlvbnM7XG4gIHJlYWRvbmx5IHVzZUF1dGhvcml6ZXJMYW1iZGE/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RDb25maWd1cmF0aW9ucyB7XG4gIC8vIG1ldGhvZEJ5UGF0aCBzaG91bGQgYmUgbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIFttZXRob2RCeVBhdGg6IHN0cmluZ106IENyb3dNZXRob2RDb25maWd1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IHNvdXJjZURpcmVjdG9yeT86IHN0cmluZztcbiAgcmVhZG9ubHkgc2hhcmVkRGlyZWN0b3J5Pzogc3RyaW5nO1xuICByZWFkb25seSB1c2VBdXRob3JpemVyTGFtYmRhPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYXV0aG9yaXplckRpcmVjdG9yeT86IHN0cmluZztcbiAgLy8gYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGxhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbj86XG4gICAgfCBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzXG4gICAgfCBhbnk7XG4gIC8vIGF1dGhvcml6ZXJDb25maWd1cmF0aW9uIHNob3VsZCBiZSBhcGlnYXRld2F5LlRva2VuQXV0aG9yaXplclByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSB0b2tlbkF1dGhvcml6ZXJDb25maWd1cmF0aW9uPzogYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXJQcm9wcyB8IGFueTtcbiAgcmVhZG9ubHkgY3JlYXRlQXBpS2V5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSBjb3JzT3B0aW9ucz86IENvcnNPcHRpb25zO1xuICAvLyBhcGlHYXR3YXlDb25maWd1cmF0aW9uIHNob3VsZCBiZSBhcGlnYXRld2F5LkxhbWJkYVJlc3RBcGlQcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgcmVhZG9ubHkgYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb24/OiBhcGlnYXRld2F5LlJlc3RBcGlQcm9wcyB8IGFueTtcbiAgcmVhZG9ubHkgYXBpR2F0ZXdheU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxhbWJkYUNvbmZpZ3VyYXRpb25zPzogQ3Jvd0xhbWJkYUNvbmZpZ3VyYXRpb25zO1xuICByZWFkb25seSBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnM/OiB7XG4gICAgW2xhbWJkYVBhdGg6IHN0cmluZ106IGFwaWdhdGV3YXkuTGFtYmRhSW50ZWdyYXRpb25PcHRpb25zO1xuICB9O1xuICByZWFkb25seSBtb2RlbHM/OiBDcm93TW9kZWxPcHRpb25zW107XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JzPzogQ3Jvd1JlcXVlc3RWYWxpZGF0b3JPcHRpb25zW107XG4gIHJlYWRvbmx5IG1ldGhvZENvbmZpZ3VyYXRpb25zPzogQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb25zO1xufVxuXG5pbnRlcmZhY2UgRlNHcmFwaE5vZGUge1xuICByZXNvdXJjZTogYXBpZ2F0ZXdheS5JUmVzb3VyY2U7XG4gIHBhdGg6IHN0cmluZztcbiAgcGF0aHM6IHN0cmluZ1tdO1xuICB2ZXJiczogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBGU0dyYXBoIHtcbiAgW3BhdGg6IHN0cmluZ106IEZTR3JhcGhOb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgQ3Jvd0FwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyBnYXRld2F5ITogYXBpZ2F0ZXdheS5SZXN0QXBpO1xuICBwdWJsaWMgdXNhZ2VQbGFuITogYXBpZ2F0ZXdheS5Vc2FnZVBsYW47XG4gIHB1YmxpYyBhdXRob3JpemVyITogYXBpZ2F0ZXdheS5JQXV0aG9yaXplcjtcbiAgcHVibGljIGF1dGhvcml6ZXJMYW1iZGEhOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbjtcbiAgcHVibGljIGxhbWJkYUxheWVyITogbGFtYmRhLkxheWVyVmVyc2lvbiB8IHVuZGVmaW5lZDtcbiAgcHVibGljIGxhbWJkYUZ1bmN0aW9ucyE6IExhbWJkYXNCeVBhdGg7XG4gIHB1YmxpYyBtb2RlbHMhOiB7IFttb2RlbE5hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH07XG4gIHB1YmxpYyByZXF1ZXN0VmFsaWRhdG9ycyE6IHtcbiAgICBbcmVxdWVzdFZhbGlkYXRvcnNOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklSZXF1ZXN0VmFsaWRhdG9yO1xuICB9O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQ3Jvd0FwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vIFB1bGxpbmcgb3V0IHByb3BzXG4gICAgY29uc3Qge1xuICAgICAgc291cmNlRGlyZWN0b3J5ID0gXCJzcmNcIixcbiAgICAgIHNoYXJlZERpcmVjdG9yeSA9IFwic2hhcmVkXCIsXG4gICAgICB1c2VBdXRob3JpemVyTGFtYmRhID0gZmFsc2UsXG4gICAgICBhdXRob3JpemVyRGlyZWN0b3J5ID0gXCJhdXRob3JpemVyXCIsXG4gICAgICBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgdG9rZW5BdXRob3JpemVyQ29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgY3JlYXRlQXBpS2V5ID0gZmFsc2UsXG4gICAgICBsb2dSZXRlbnRpb24gPSBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICBhcGlHYXRld2F5Q29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgYXBpR2F0ZXdheU5hbWUgPSBcImNyb3ctYXBpXCIsXG4gICAgICBsYW1iZGFDb25maWd1cmF0aW9ucyA9IHt9LFxuICAgICAgbGFtYmRhSW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgICBtb2RlbHMgPSBbXSxcbiAgICAgIHJlcXVlc3RWYWxpZGF0b3JzID0gW10sXG4gICAgICBtZXRob2RDb25maWd1cmF0aW9ucyA9IHt9LFxuICAgICAgY29yc09wdGlvbnMgPSBudWxsXG4gICAgfSA9IHByb3BzO1xuXG4gICAgLy8gSW5pdGlhbGl6aW5nIGNvbnN0YW50c1xuICAgIGNvbnN0IExBTUJEQV9SVU5USU1FID0gbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1g7XG4gICAgY29uc3QgU1BFQ0lBTF9ESVJFQ1RPUklFUyA9IFtzaGFyZWREaXJlY3RvcnksIGF1dGhvcml6ZXJEaXJlY3RvcnldO1xuXG4gICAgLy8gSGVscGVycyBmdW5jdGlvbnMgZm9yIGNvbnN0cnVjdG9yXG5cbiAgICAvLyBQcmVwYXJlcyBkZWZhdWx0IExhbWJkYSBwcm9wcyBhbmQgb3ZlcnJpZGVzIHRoZW0gd2l0aCB1c2VyIGlucHV0XG4gICAgZnVuY3Rpb24gYnVuZGxlTGFtYmRhUHJvcHMoXG4gICAgICBjb2RlUGF0aDogc3RyaW5nLFxuICAgICAgdXNlckNvbmZpZ3VyYXRpb246IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHMsXG4gICAgICBzaGFyZWRMYXllcjogbGFtYmRhLkxheWVyVmVyc2lvbiB8IHVuZGVmaW5lZFxuICAgICkge1xuICAgICAgbGV0IGxheWVycztcbiAgICAgIGlmIChzaGFyZWRMYXllcikge1xuICAgICAgICBjb25zdCB7IGxheWVyczogdXNlckxheWVycyA9IFtdIH0gPSB1c2VyQ29uZmlndXJhdGlvbjtcbiAgICAgICAgbGF5ZXJzID0gW3NoYXJlZExheWVyLCAuLi51c2VyTGF5ZXJzXTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGVmYXVsdFByb3BzID0ge1xuICAgICAgICBydW50aW1lOiBMQU1CREFfUlVOVElNRSxcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KGNvZGVQYXRoKSxcbiAgICAgICAgZW50cnk6IGAke2NvZGVQYXRofS9pbmRleC5qc2AsXG4gICAgICAgIGhhbmRsZXI6IFwiaGFuZGxlclwiLFxuICAgICAgICBsb2dSZXRlbnRpb25cbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IGxhbWJkYVByb3BzID0ge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIC4uLnVzZXJDb25maWd1cmF0aW9uLCAvLyBMZXQgdXNlciBjb25maWd1cmF0aW9uIG92ZXJyaWRlIGFueXRoaW5nIGV4Y2VwdCBsYXllcnNcbiAgICAgICAgbGF5ZXJzXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gbGFtYmRhUHJvcHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0TGFtYmRhQ29uZmlnKG5ld0FwaVBhdGg6IHN0cmluZykge1xuICAgICAgLy8gaWYgZGlyZWN0IG1hdGNoIHJldHVybiByaWdodCBhd2F5XG4gICAgICBpZiAobGFtYmRhQ29uZmlndXJhdGlvbnNbbmV3QXBpUGF0aF0pIHtcbiAgICAgICAgcmV0dXJuIGxhbWJkYUNvbmZpZ3VyYXRpb25zW25ld0FwaVBhdGhdO1xuICAgICAgfVxuXG4gICAgICAvLyBjaGVjayBhbGwgcm91dGUgd2lsZCBjYXJkIG9wdGlvbnMgZm9yIG1hdGNoaW5nIGNvbmZpZ3NcbiAgICAgIGxldCBiYXNlUm91dGU6IHN0cmluZyA9IFwiXCI7XG4gICAgICBjb25zdCBtYXRjaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gbmV3QXBpUGF0aFxuICAgICAgICAuc3BsaXQoXCIvXCIpXG4gICAgICAgIC5tYXAoKHNlZ21lbnQpID0+IHtcbiAgICAgICAgICBpZiAoc2VnbWVudCkge1xuICAgICAgICAgICAgYmFzZVJvdXRlICs9IGAvJHtzZWdtZW50fWA7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBgJHtiYXNlUm91dGV9LypgO1xuICAgICAgICB9KVxuICAgICAgICAuZmluZCgod2lsZGNhcmQpID0+ICEhbGFtYmRhQ29uZmlndXJhdGlvbnNbd2lsZGNhcmRdKTtcblxuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgIHJldHVybiBsYW1iZGFDb25maWd1cmF0aW9uc1ttYXRjaF07XG4gICAgICB9XG5cbiAgICAgIC8vIHJldHVybnMgZW1wdHkgY29uZmlnXG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgLy8gUmV0dXJucyBjaGlsZCBkaXJlY3RvcmllcyBnaXZlbiB0aGUgcGF0aCBvZiBhIHBhcmVudFxuICAgIGZ1bmN0aW9uIGdldERpcmVjdG9yeUNoaWxkcmVuKHBhcmVudERpcmVjdG9yeTogc3RyaW5nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkaXJlY3RvcmllcyA9IGZzZVxuICAgICAgICAgIC5yZWFkZGlyU3luYyhwYXJlbnREaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgICAgIC5maWx0ZXIoKGRpcmVudDogYW55KSA9PiBkaXJlbnQuaXNEaXJlY3RvcnkoKSlcbiAgICAgICAgICAubWFwKChkaXJlbnQ6IGFueSkgPT4gZGlyZW50Lm5hbWUpO1xuICAgICAgICByZXR1cm4gZGlyZWN0b3JpZXM7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBvbmx5IHRpbWUgSSBoYXZlIHJ1biBpbnRvIHRoaXMgd2FzIHdoZW4gdGhlIHNyYy8gZGlyZWN0b3J5XG4gICAgICAgICAqIHdhcyBlbXB0eS5cbiAgICAgICAgICogSWYgaXQgaXMgZW1wdHksIGxldCBDREsgdHJlZSB2YWxpZGF0aW9uIHRlbGwgdXNlciB0aGF0IHRoZVxuICAgICAgICAgKiBSRVNUIEFQSSBkb2VzIG5vdCBoYXZlIGFueSBtZXRob2RzLlxuICAgICAgICAgKi9cbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICAvLyBBUEkgR2F0ZXdheSBsb2cgZ3JvdXBcbiAgICBjb25zdCBnYXRld2F5TG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcImFwaS1hY2Nlc3MtbG9nc1wiLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFS1xuICAgIH0pO1xuXG4gICAgLy8gVGhlIEFQSSBHYXRld2F5IGl0c2VsZlxuICAgIGNvbnN0IGdhdGV3YXkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsIGFwaUdhdGV3YXlOYW1lLCB7XG4gICAgICBkZXBsb3k6IHRydWUsXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIGxvZ2dpbmdMZXZlbDogYXBpZ2F0ZXdheS5NZXRob2RMb2dnaW5nTGV2ZWwuRVJST1IsXG4gICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBuZXcgYXBpZ2F0ZXdheS5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKFxuICAgICAgICAgIGdhdGV3YXlMb2dHcm91cFxuICAgICAgICApXG4gICAgICB9LFxuICAgICAgYXBpS2V5U291cmNlVHlwZTogY3JlYXRlQXBpS2V5XG4gICAgICAgID8gYXBpZ2F0ZXdheS5BcGlLZXlTb3VyY2VUeXBlLkhFQURFUlxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIGRlZmF1bHRDb3JzUHJlZmxpZ2h0T3B0aW9uczogY29yc09wdGlvbnMgPyBjb3JzT3B0aW9ucyA6IHVuZGVmaW5lZCxcbiAgICAgIC4uLmFwaUdhdGV3YXlDb25maWd1cmF0aW9uXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVkTW9kZWxzOiB7IFttb2RlbE5hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH0gPSB7fTtcbiAgICBtb2RlbHMuZm9yRWFjaCgobW9kZWw6IENyb3dNb2RlbE9wdGlvbnMpID0+IHtcbiAgICAgIC8vIG1vZGVsTmFtZSBpcyB1c2VkIGFzIElEIGFuZCBjYW4gbm93IGJlIHVzZWQgZm9yIHJlZmVyZW5jaW5nIG1vZGVsIGluIG1ldGhvZCBvcHRpb25zXG4gICAgICBjcmVhdGVkTW9kZWxzW21vZGVsLm1vZGVsTmFtZV0gPSBnYXRld2F5LmFkZE1vZGVsKG1vZGVsLm1vZGVsTmFtZSwgbW9kZWwpO1xuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9yczoge1xuICAgICAgW3JlcXVlc3RWYWxpZGF0b3JzTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JUmVxdWVzdFZhbGlkYXRvcjtcbiAgICB9ID0ge307XG4gICAgcmVxdWVzdFZhbGlkYXRvcnMuZm9yRWFjaChcbiAgICAgIChyZXF1ZXN0VmFsaWRhdG9yOiBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnMpID0+IHtcbiAgICAgICAgLy8gcmVxdWVzdFZhbGlkYXRvck5hbWUgaXMgdXNlZCBhcyBJRCBhbmQgY2FuIG5vdyBiZSB1c2VkIGZvciByZWZlcmVuY2luZyBtb2RlbCBpbiBtZXRob2Qgb3B0aW9uc1xuICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvci5yZXF1ZXN0VmFsaWRhdG9yTmFtZV0gPVxuICAgICAgICAgIGdhdGV3YXkuYWRkUmVxdWVzdFZhbGlkYXRvcihcbiAgICAgICAgICAgIHJlcXVlc3RWYWxpZGF0b3IucmVxdWVzdFZhbGlkYXRvck5hbWUsXG4gICAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIEFQSSBrZXkgaWYgZGVzaXJlZFxuICAgIGlmIChjcmVhdGVBcGlLZXkpIHtcbiAgICAgIGNvbnN0IGFwaUtleSA9IGdhdGV3YXkuYWRkQXBpS2V5KFwiYXBpLWtleVwiKTtcbiAgICAgIGNvbnN0IHVzYWdlUGxhbiA9IG5ldyBhcGlnYXRld2F5LlVzYWdlUGxhbih0aGlzLCBcInVzYWdlLXBsYW5cIiwge1xuICAgICAgICB0aHJvdHRsZToge1xuICAgICAgICAgIGJ1cnN0TGltaXQ6IDUwMDAsXG4gICAgICAgICAgcmF0ZUxpbWl0OiAxMDAwMFxuICAgICAgICB9LFxuICAgICAgICBhcGlTdGFnZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhcGk6IGdhdGV3YXksXG4gICAgICAgICAgICBzdGFnZTogZ2F0ZXdheS5kZXBsb3ltZW50U3RhZ2VcbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0pO1xuICAgICAgdXNhZ2VQbGFuLmFkZEFwaUtleShhcGlLZXkpO1xuICAgICAgdGhpcy51c2FnZVBsYW4gPSB1c2FnZVBsYW47XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBsYXllciBvdXQgb2Ygc2hhcmVkIGRpcmVjdG9yeSBpZiBpdCBleGlzdHNcbiAgICBjb25zdCBzb3VyY2VTaGFyZWREaXJlY3RvcnkgPSBgJHtzb3VyY2VEaXJlY3Rvcnl9LyR7c2hhcmVkRGlyZWN0b3J5fWA7XG4gICAgbGV0IHNoYXJlZExheWVyOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkO1xuICAgIGlmIChmc2UuZXhpc3RzU3luYyhzb3VyY2VTaGFyZWREaXJlY3RvcnkpKSB7XG4gICAgICBzaGFyZWRMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsIFwic2hhcmVkLWxheWVyXCIsIHtcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHNvdXJjZVNoYXJlZERpcmVjdG9yeSksXG4gICAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW0xBTUJEQV9SVU5USU1FXSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMubGFtYmRhTGF5ZXIgPSBzaGFyZWRMYXllcjtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGF1dGhvcml6ZXIgdG8gYmUgdXNlZCBpbiBzdWJzZXF1ZW50IE1ldGhvZHNcbiAgICBsZXQgdG9rZW5BdXRob3JpemVyOiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICAgIGlmICh1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICBjb25zdCBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSA9IGAke3NvdXJjZURpcmVjdG9yeX0vJHthdXRob3JpemVyRGlyZWN0b3J5fWA7XG5cbiAgICAgIGNvbnN0IGF1dGhvcml6ZXJMYW1iZGFQcm9wcyA9IGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgICBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSxcbiAgICAgICAgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24sXG4gICAgICAgIHNoYXJlZExheWVyXG4gICAgICApO1xuXG4gICAgICBjb25zdCBhdXRob3JpemVyTGFtYmRhID0gbmV3IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcImF1dGhvcml6ZXItbGFtYmRhXCIsXG4gICAgICAgIGF1dGhvcml6ZXJMYW1iZGFQcm9wc1xuICAgICAgKTtcbiAgICAgIHRoaXMuYXV0aG9yaXplckxhbWJkYSA9IGF1dGhvcml6ZXJMYW1iZGE7XG5cbiAgICAgIGNvbnN0IGJ1bmRsZWRUb2tlbkF1dGhDb25maWcgPSB7XG4gICAgICAgIGhhbmRsZXI6IGF1dGhvcml6ZXJMYW1iZGEsXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzYwMCksXG4gICAgICAgIC4uLnRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb25cbiAgICAgIH07XG4gICAgICB0b2tlbkF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXIoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwidG9rZW4tYXV0aG9yaXplclwiLFxuICAgICAgICBidW5kbGVkVG9rZW5BdXRoQ29uZmlnXG4gICAgICApO1xuICAgICAgdGhpcy5hdXRob3JpemVyID0gdG9rZW5BdXRob3JpemVyO1xuICAgIH1cblxuICAgIC8vIFRpbWUgdG8gc3RhcnQgd2Fsa2luZyB0aGUgZGlyZWN0b3JpZXNcbiAgICBjb25zdCByb290ID0gc291cmNlRGlyZWN0b3J5O1xuICAgIGNvbnN0IHZlcmJzID0gW1wiZ2V0XCIsIFwicG9zdFwiLCBcInB1dFwiLCBcImRlbGV0ZVwiXTtcbiAgICBjb25zdCBncmFwaDogRlNHcmFwaCA9IHt9O1xuICAgIGNvbnN0IGxhbWJkYXNCeVBhdGg6IExhbWJkYXNCeVBhdGggPSB7fTtcblxuICAgIC8vIEluaXRpYWxpemUgd2l0aCByb290XG4gICAgZ3JhcGhbXCIvXCJdID0ge1xuICAgICAgcmVzb3VyY2U6IGdhdGV3YXkucm9vdCxcbiAgICAgIHBhdGg6IHJvb3QsXG4gICAgICBwYXRoczogW10sXG4gICAgICB2ZXJiczogW11cbiAgICB9O1xuICAgIC8vIEZpcnN0IGVsZW1lbnQgaW4gdHVwbGUgaXMgZGlyZWN0b3J5IHBhdGgsIHNlY29uZCBpcyBBUEkgcGF0aFxuICAgIGNvbnN0IG5vZGVzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbW3Jvb3QsIFwiL1wiXV07XG5cbiAgICAvLyBCRlMgdGhhdCBjcmVhdGVzIEFQSSBHYXRld2F5IHN0cnVjdHVyZSB1c2luZyBhZGRNZXRob2RcbiAgICB3aGlsZSAobm9kZXMubGVuZ3RoKSB7XG4gICAgICAvLyBUaGUgYHx8IFsndHlwZScsICdzY3JpcHQnXWAgcGllY2UgaXMgbmVlZGVkIG9yIFRTIHRocm93cyBhIGZpdFxuICAgICAgY29uc3QgW2RpcmVjdG9yeVBhdGgsIGFwaVBhdGhdID0gbm9kZXMuc2hpZnQoKSB8fCBbXCJ0eXBlXCIsIFwic2NyaXB0XCJdO1xuICAgICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gZ2V0RGlyZWN0b3J5Q2hpbGRyZW4oZGlyZWN0b3J5UGF0aCk7XG5cbiAgICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAgIC8vIGNvbnNvbGUubG9nKGAke2FwaVBhdGh9J3MgY2hpbGRyZW4gYXJlOiAke2NoaWxkcmVufWApO1xuXG4gICAgICAvLyBEb24ndCBoYXZlIHRvIHdvcnJ5IGFib3V0IHByZXZpb3VzbHkgdmlzaXRlZCBub2Rlc1xuICAgICAgLy8gc2luY2UgdGhpcyBpcyBhIGZpbGUgc3RydWN0dXJlXG4gICAgICAvLyAuLi51bmxlc3MgdGhlcmUgYXJlIHN5bWxpbmtzPyBIYXZlbid0IHJ1biBpbnRvIHRoYXRcbiAgICAgIGNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB7XG4gICAgICAgIGNvbnN0IG5ld0RpcmVjdG9yeVBhdGggPSBgJHtkaXJlY3RvcnlQYXRofS8ke2NoaWxkfWA7XG4gICAgICAgIC8vIElmIHdlJ3JlIG9uIHRoZSByb290IHBhdGgsIGRvbid0IHNlcGFyYXRlIHdpdGggYSBzbGFzaCAoLylcbiAgICAgICAgLy8gICBiZWNhdXNlIGl0IGVuZHMgdXAgbG9va2luZyBsaWtlIC8vY2hpbGQtcGF0aFxuICAgICAgICBjb25zdCBuZXdBcGlQYXRoID1cbiAgICAgICAgICBhcGlQYXRoID09PSBcIi9cIiA/IGAvJHtjaGlsZH1gIDogYCR7YXBpUGF0aH0vJHtjaGlsZH1gO1xuXG4gICAgICAgIGlmICh2ZXJicy5pbmNsdWRlcyhjaGlsZCkpIHtcbiAgICAgICAgICAvLyBJZiBkaXJlY3RvcnkgaXMgYSB2ZXJiLCB3ZSBkb24ndCB0cmF2ZXJzZSBpdCBhbnltb3JlXG4gICAgICAgICAgLy8gICBhbmQgbmVlZCB0byBjcmVhdGUgYW4gQVBJIEdhdGV3YXkgbWV0aG9kIGFuZCBMYW1iZGFcbiAgICAgICAgICBjb25zdCB1c2VyTGFtYmRhQ29uZmlndXJhdGlvbiA9IGdldExhbWJkYUNvbmZpZyhuZXdBcGlQYXRoKTtcbiAgICAgICAgICBjb25zdCBsYW1iZGFQcm9wcyA9IGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgICAgICAgbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIHVzZXJMYW1iZGFDb25maWd1cmF0aW9uLFxuICAgICAgICAgICAgc2hhcmVkTGF5ZXJcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IG5ld0xhbWJkYSA9IG5ldyBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbihcbiAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICBuZXdEaXJlY3RvcnlQYXRoLFxuICAgICAgICAgICAgbGFtYmRhUHJvcHNcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgLy8gUHVsbCBvdXQgdXNlQXV0aG9yaXplckxhbWJkYSB2YWx1ZSBhbmQgdGhlIHR3ZWFrZWQgbW9kZWwgdmFsdWVzXG4gICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgdXNlQXV0aG9yaXplckxhbWJkYTogYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyZWQgPSBmYWxzZSxcbiAgICAgICAgICAgIHJlcXVlc3RNb2RlbHM6IGNyb3dSZXF1ZXN0TW9kZWxzLFxuICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiBjcm93TWV0aG9kUmVzcG9uc2VzLFxuICAgICAgICAgICAgcmVxdWVzdFZhbGlkYXRvcjogcmVxdWVzdFZhbGlkYXRvclN0cmluZyxcbiAgICAgICAgICAgIC4uLnVzZXJNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgfSA9IG1ldGhvZENvbmZpZ3VyYXRpb25zW25ld0FwaVBhdGhdIHx8IHt9O1xuICAgICAgICAgIGxldCBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbjogYW55ID0ge1xuICAgICAgICAgICAgLi4udXNlck1ldGhvZENvbmZpZ3VyYXRpb25cbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgLy8gTWFwIG1vZGVsc1xuICAgICAgICAgIGNvbnN0IHJlcXVlc3RNb2RlbHM6IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbCB9ID1cbiAgICAgICAgICAgIHt9O1xuICAgICAgICAgIGlmIChjcm93UmVxdWVzdE1vZGVscykge1xuICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoY3Jvd1JlcXVlc3RNb2RlbHMpLmZvckVhY2goXG4gICAgICAgICAgICAgIChbY29udGVudFR5cGUsIG1vZGVsTmFtZV0pID0+IHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TW9kZWxzW2NvbnRlbnRUeXBlXSA9IGNyZWF0ZWRNb2RlbHNbbW9kZWxOYW1lXTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBtZXRob2RSZXNwb25zZXM6IGFwaWdhdGV3YXkuTWV0aG9kUmVzcG9uc2VbXSA9IFtdO1xuICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2VzICYmIGNyb3dNZXRob2RSZXNwb25zZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY3Jvd01ldGhvZFJlc3BvbnNlcy5mb3JFYWNoKChjcm93TWV0aG9kUmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VNb2RlbHM6IHtcbiAgICAgICAgICAgICAgICBbY29udGVudFR5cGU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsO1xuICAgICAgICAgICAgICB9ID0ge307XG4gICAgICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjcm93UmVzcG9uc2VNb2RlbHMgPSBjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHM7XG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoY3Jvd1Jlc3BvbnNlTW9kZWxzKS5mb3JFYWNoKFxuICAgICAgICAgICAgICAgICAgKFtjb250ZW50VHlwZSwgbW9kZWxOYW1lXSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1tjb250ZW50VHlwZV0gPSBjcmVhdGVkTW9kZWxzW21vZGVsTmFtZV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHsgc3RhdHVzQ29kZSwgcmVzcG9uc2VQYXJhbWV0ZXJzIH0gPSBjcm93TWV0aG9kUmVzcG9uc2U7XG4gICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVycyxcbiAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEZpbmQgcmVxdWVzdCB2YWxpZGF0b3JcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yU3RyaW5nICYmXG4gICAgICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ11cbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLnJlcXVlc3RWYWxpZGF0b3IgPVxuICAgICAgICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ucmVxdWVzdE1vZGVscyA9IHJlcXVlc3RNb2RlbHM7XG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ubWV0aG9kUmVzcG9uc2VzID0gbWV0aG9kUmVzcG9uc2VzO1xuICAgICAgICAgIC8vIElmIHRoaXMgbWV0aG9kIHNob3VsZCBiZSBiZWhpbmQgYW4gYXV0aG9yaXplciBMYW1iZGFcbiAgICAgICAgICAvLyAgIGNvbnN0cnVjdCB0aGUgbWV0aG9kQ29uZmlndXJhdGlvbiBvYmplY3QgYXMgc3VjaFxuICAgICAgICAgIGlmIChhdXRob3JpemVyTGFtYmRhQ29uZmlndXJlZCAmJiB1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbi5hdXRob3JpemF0aW9uVHlwZSA9XG4gICAgICAgICAgICAgIGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ1VTVE9NO1xuICAgICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24uYXV0aG9yaXplciA9IHRva2VuQXV0aG9yaXplcjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbk9wdGlvbnMgPSBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnNbbmV3QXBpUGF0aF0gfHwge307XG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucmVzb3VyY2UuYWRkTWV0aG9kKFxuICAgICAgICAgICAgY2hpbGQudG9VcHBlckNhc2UoKSxcbiAgICAgICAgICAgIG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKG5ld0xhbWJkYSwgaW50ZWdyYXRpb25PcHRpb25zKSxcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAoY29yc09wdGlvbnMpIHtcbiAgICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnJlc291cmNlLmFkZENvcnNQcmVmbGlnaHQoY29yc09wdGlvbnMpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBncmFwaFthcGlQYXRoXS52ZXJicy5wdXNoKGNoaWxkKTtcbiAgICAgICAgICBsYW1iZGFzQnlQYXRoW25ld0FwaVBhdGhdID0gbmV3TGFtYmRhO1xuICAgICAgICB9IGVsc2UgaWYgKFNQRUNJQUxfRElSRUNUT1JJRVMuaW5jbHVkZXMoY2hpbGQpKSB7XG4gICAgICAgICAgLy8gVGhlIHNwZWNpYWwgZGlyZWN0b3JpZXMgc2hvdWxkIG5vdCByZXN1bHQgaW4gYW4gQVBJIHBhdGhcbiAgICAgICAgICAvLyBUaGlzIG1lYW5zIHRoZSBBUEkgYWxzbyBjYW5ub3QgaGF2ZSBhIHJlc291cmNlIHdpdGggdGhlXG4gICAgICAgICAgLy8gICBzYW1lIG5hbWVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBJZiBkaXJlY3RvcnkgaXMgbm90IGEgdmVyYiwgY3JlYXRlIG5ldyBBUEkgR2F0ZXdheSByZXNvdXJjZVxuICAgICAgICAgIC8vICAgZm9yIHVzZSBieSB2ZXJiIGRpcmVjdG9yeSBsYXRlclxuXG4gICAgICAgICAgY29uc3QgbmV3UmVzb3VyY2UgPSBncmFwaFthcGlQYXRoXS5yZXNvdXJjZS5yZXNvdXJjZUZvclBhdGgoY2hpbGQpO1xuXG4gICAgICAgICAgbm9kZXMucHVzaChbbmV3RGlyZWN0b3J5UGF0aCwgbmV3QXBpUGF0aF0pO1xuXG4gICAgICAgICAgLy8gQWRkIGNoaWxkIHRvIHBhcmVudCdzIHBhdGhzXG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucGF0aHMucHVzaChjaGlsZCk7XG5cbiAgICAgICAgICAvLyBJbml0aWFsaXplIGdyYXBoIG5vZGUgdG8gaW5jbHVkZSBjaGlsZFxuICAgICAgICAgIGdyYXBoW25ld0FwaVBhdGhdID0ge1xuICAgICAgICAgICAgcmVzb3VyY2U6IG5ld1Jlc291cmNlLFxuICAgICAgICAgICAgcGF0aDogbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIHBhdGhzOiBbXSxcbiAgICAgICAgICAgIHZlcmJzOiBbXVxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAvLyBjb25zb2xlLmxvZyhncmFwaCk7XG5cbiAgICAvLyBFeHBvc2UgQVBJIEdhdGV3YXlcbiAgICB0aGlzLmdhdGV3YXkgPSBnYXRld2F5O1xuICAgIHRoaXMubGFtYmRhRnVuY3Rpb25zID0gbGFtYmRhc0J5UGF0aDtcbiAgICB0aGlzLm1vZGVscyA9IGNyZWF0ZWRNb2RlbHM7XG4gICAgdGhpcy5yZXF1ZXN0VmFsaWRhdG9ycyA9IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9ycztcbiAgfVxufVxuIl19