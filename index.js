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
        function getConfig(configurations, newApiPath) {
            // if direct match return right away
            if (configurations[newApiPath]) {
                return configurations[newApiPath];
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
                .find((wildcard) => !!configurations[wildcard]);
            if (match) {
                return configurations[match];
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
                    const userLambdaConfiguration = getConfig(lambdaConfigurations, newApiPath);
                    const lambdaProps = bundleLambdaProps(newDirectoryPath, userLambdaConfiguration, sharedLayer);
                    const newLambda = new node_lambda.NodejsFunction(this, newDirectoryPath, lambdaProps);
                    // Pull out useAuthorizerLambda value and the tweaked model values
                    const { useAuthorizerLambda: authorizerLambdaConfigured = false, requestModels: crowRequestModels, methodResponses: crowMethodResponses, requestValidator: requestValidatorString, ...userMethodConfiguration } = getConfig(methodConfigurations, newApiPath);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBdUM7QUFDdkMsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBRTdDOztHQUVHO0FBQ0gsZ0NBQWdDOzs7O0FBcUdoQyxNQUFhLE9BQVEsU0FBUSxzQkFBUzs7OztJQWFwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsb0JBQW9CO1FBQ3BCLE1BQU0sRUFDSixlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsUUFBUSxFQUMxQixtQkFBbUIsR0FBRyxLQUFLLEVBQzNCLG1CQUFtQixHQUFHLFlBQVksRUFDbEMsNkJBQTZCLEdBQUcsRUFBRSxFQUNsQyw0QkFBNEIsR0FBRyxFQUFFLEVBQ2pDLFlBQVksR0FBRyxLQUFLLEVBQ3BCLFlBQVksR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFDMUMsdUJBQXVCLEdBQUcsRUFBRSxFQUM1QixjQUFjLEdBQUcsVUFBVSxFQUMzQixvQkFBb0IsR0FBRyxFQUFFLEVBQ3pCLHdCQUF3QixHQUFHLEVBQUUsRUFDN0IsTUFBTSxHQUFHLEVBQUUsRUFDWCxpQkFBaUIsR0FBRyxFQUFFLEVBQ3RCLG9CQUFvQixHQUFHLEVBQUUsRUFDekIsV0FBVyxHQUFHLElBQUksRUFDbkIsR0FBRyxLQUFLLENBQUM7UUFFVix5QkFBeUI7UUFDekIsTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUM7UUFDbEQsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLGVBQWUsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRW5FLG9DQUFvQztRQUVwQyxtRUFBbUU7UUFDbkUsU0FBUyxpQkFBaUIsQ0FDeEIsUUFBZ0IsRUFDaEIsaUJBQWtELEVBQ2xELFdBQTRDO1lBRTVDLElBQUksTUFBTSxDQUFDO1lBQ1gsSUFBSSxXQUFXLEVBQUU7Z0JBQ2YsTUFBTSxFQUFFLE1BQU0sRUFBRSxVQUFVLEdBQUcsRUFBRSxFQUFFLEdBQUcsaUJBQWlCLENBQUM7Z0JBQ3RELE1BQU0sR0FBRyxDQUFDLFdBQVcsRUFBRSxHQUFHLFVBQVUsQ0FBQyxDQUFDO2FBQ3ZDO1lBRUQsTUFBTSxZQUFZLEdBQUc7Z0JBQ25CLE9BQU8sRUFBRSxjQUFjO2dCQUN2QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDO2dCQUNyQyxLQUFLLEVBQUUsR0FBRyxRQUFRLFdBQVc7Z0JBQzdCLE9BQU8sRUFBRSxTQUFTO2dCQUNsQixZQUFZO2FBQ2IsQ0FBQztZQUVGLE1BQU0sV0FBVyxHQUFHO2dCQUNsQixHQUFHLFlBQVk7Z0JBQ2YsR0FBRyxpQkFBaUI7Z0JBQ3BCLE1BQU07YUFDUCxDQUFDO1lBRUYsT0FBTyxXQUFXLENBQUM7UUFDckIsQ0FBQztRQUVELFNBQVMsU0FBUyxDQUNoQixjQUFtRSxFQUNuRSxVQUFrQjtZQUVsQixvQ0FBb0M7WUFDcEMsSUFBSSxjQUFjLENBQUMsVUFBVSxDQUFDLEVBQUU7Z0JBQzlCLE9BQU8sY0FBYyxDQUFDLFVBQVUsQ0FBQyxDQUFDO2FBQ25DO1lBRUQseURBQXlEO1lBQ3pELElBQUksU0FBUyxHQUFXLEVBQUUsQ0FBQztZQUMzQixNQUFNLEtBQUssR0FBdUIsVUFBVTtpQkFDekMsS0FBSyxDQUFDLEdBQUcsQ0FBQztpQkFDVixHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtnQkFDZixJQUFJLE9BQU8sRUFBRTtvQkFDWCxTQUFTLElBQUksSUFBSSxPQUFPLEVBQUUsQ0FBQztpQkFDNUI7Z0JBQ0QsT0FBTyxHQUFHLFNBQVMsSUFBSSxDQUFDO1lBQzFCLENBQUMsQ0FBQztpQkFDRCxJQUFJLENBQUMsQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztZQUVsRCxJQUFJLEtBQUssRUFBRTtnQkFDVCxPQUFPLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQzthQUM5QjtZQUVELHVCQUF1QjtZQUN2QixPQUFPLEVBQUUsQ0FBQztRQUNaLENBQUM7UUFFRCx1REFBdUQ7UUFDdkQsU0FBUyxvQkFBb0IsQ0FBQyxlQUF1QjtZQUNuRCxJQUFJO2dCQUNGLE1BQU0sV0FBVyxHQUFHLEdBQUc7cUJBQ3BCLFdBQVcsQ0FBQyxlQUFlLEVBQUUsRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLENBQUM7cUJBQ3JELE1BQU0sQ0FBQyxDQUFDLE1BQVcsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFdBQVcsRUFBRSxDQUFDO3FCQUM3QyxHQUFHLENBQUMsQ0FBQyxNQUFXLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDckMsT0FBTyxXQUFXLENBQUM7YUFDcEI7WUFBQyxNQUFNO2dCQUNOOzs7OzttQkFLRzthQUNKO1lBQ0QsT0FBTyxFQUFFLENBQUM7UUFDWixDQUFDO1FBRUQsd0JBQXdCO1FBQ3hCLE1BQU0sZUFBZSxHQUFHLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDakUsU0FBUyxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUTtTQUN2QyxDQUFDLENBQUM7UUFFSCx5QkFBeUI7UUFDekIsTUFBTSxPQUFPLEdBQUcsSUFBSSxVQUFVLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDM0QsTUFBTSxFQUFFLElBQUk7WUFDWixhQUFhLEVBQUU7Z0JBQ2IsWUFBWSxFQUFFLFVBQVUsQ0FBQyxrQkFBa0IsQ0FBQyxLQUFLO2dCQUNqRCxvQkFBb0IsRUFBRSxJQUFJLFVBQVUsQ0FBQyxzQkFBc0IsQ0FDekQsZUFBZSxDQUNoQjthQUNGO1lBQ0QsZ0JBQWdCLEVBQUUsWUFBWTtnQkFDNUIsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0IsQ0FBQyxNQUFNO2dCQUNwQyxDQUFDLENBQUMsU0FBUztZQUNiLDJCQUEyQixFQUFFLFdBQVcsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxTQUFTO1lBQ2xFLEdBQUcsdUJBQXVCO1NBQzNCLENBQUMsQ0FBQztRQUVILE1BQU0sYUFBYSxHQUErQyxFQUFFLENBQUM7UUFDckUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQXVCLEVBQUUsRUFBRTtZQUN6QyxzRkFBc0Y7WUFDdEYsYUFBYSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsR0FBRyxPQUFPLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDNUUsQ0FBQyxDQUFDLENBQUM7UUFDSCxNQUFNLHdCQUF3QixHQUUxQixFQUFFLENBQUM7UUFDUCxpQkFBaUIsQ0FBQyxPQUFPLENBQ3ZCLENBQUMsZ0JBQTZDLEVBQUUsRUFBRTtZQUNoRCxpR0FBaUc7WUFDakcsd0JBQXdCLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQUM7Z0JBQzdELE9BQU8sQ0FBQyxtQkFBbUIsQ0FDekIsZ0JBQWdCLENBQUMsb0JBQW9CLEVBQ3JDLGdCQUFnQixDQUNqQixDQUFDO1FBQ04sQ0FBQyxDQUNGLENBQUM7UUFFRiw0QkFBNEI7UUFDNUIsSUFBSSxZQUFZLEVBQUU7WUFDaEIsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUM1QyxNQUFNLFNBQVMsR0FBRyxJQUFJLFVBQVUsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDN0QsUUFBUSxFQUFFO29CQUNSLFVBQVUsRUFBRSxJQUFJO29CQUNoQixTQUFTLEVBQUUsS0FBSztpQkFDakI7Z0JBQ0QsU0FBUyxFQUFFO29CQUNUO3dCQUNFLEdBQUcsRUFBRSxPQUFPO3dCQUNaLEtBQUssRUFBRSxPQUFPLENBQUMsZUFBZTtxQkFDL0I7aUJBQ0Y7YUFDRixDQUFDLENBQUM7WUFDSCxTQUFTLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzVCLElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO1NBQzVCO1FBRUQsMkRBQTJEO1FBQzNELE1BQU0scUJBQXFCLEdBQUcsR0FBRyxlQUFlLElBQUksZUFBZSxFQUFFLENBQUM7UUFDdEUsSUFBSSxXQUE0QyxDQUFDO1FBQ2pELElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxxQkFBcUIsQ0FBQyxFQUFFO1lBQ3pDLFdBQVcsR0FBRyxJQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtnQkFDMUQsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLHFCQUFxQixDQUFDO2dCQUNsRCxrQkFBa0IsRUFBRSxDQUFDLGNBQWMsQ0FBQztnQkFDcEMsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTzthQUN6QyxDQUFDLENBQUM7WUFFSCxJQUFJLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztTQUNoQztRQUVELDREQUE0RDtRQUM1RCxJQUFJLGVBQXVDLENBQUM7UUFDNUMsSUFBSSxtQkFBbUIsRUFBRTtZQUN2QixNQUFNLHVCQUF1QixHQUFHLEdBQUcsZUFBZSxJQUFJLG1CQUFtQixFQUFFLENBQUM7WUFFNUUsTUFBTSxxQkFBcUIsR0FBRyxpQkFBaUIsQ0FDN0MsdUJBQXVCLEVBQ3ZCLDZCQUE2QixFQUM3QixXQUFXLENBQ1osQ0FBQztZQUVGLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxXQUFXLENBQUMsY0FBYyxDQUNyRCxJQUFJLEVBQ0osbUJBQW1CLEVBQ25CLHFCQUFxQixDQUN0QixDQUFDO1lBQ0YsSUFBSSxDQUFDLGdCQUFnQixHQUFHLGdCQUFnQixDQUFDO1lBRXpDLE1BQU0sc0JBQXNCLEdBQUc7Z0JBQzdCLE9BQU8sRUFBRSxnQkFBZ0I7Z0JBQ3pCLGVBQWUsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7Z0JBQzNDLEdBQUcsNEJBQTRCO2FBQ2hDLENBQUM7WUFDRixlQUFlLEdBQUcsSUFBSSxVQUFVLENBQUMsZUFBZSxDQUM5QyxJQUFJLEVBQ0osa0JBQWtCLEVBQ2xCLHNCQUFzQixDQUN2QixDQUFDO1lBQ0YsSUFBSSxDQUFDLFVBQVUsR0FBRyxlQUFlLENBQUM7U0FDbkM7UUFFRCx3Q0FBd0M7UUFDeEMsTUFBTSxJQUFJLEdBQUcsZUFBZSxDQUFDO1FBQzdCLE1BQU0sS0FBSyxHQUFHLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDL0MsTUFBTSxLQUFLLEdBQVksRUFBRSxDQUFDO1FBQzFCLE1BQU0sYUFBYSxHQUFrQixFQUFFLENBQUM7UUFFeEMsdUJBQXVCO1FBQ3ZCLEtBQUssQ0FBQyxHQUFHLENBQUMsR0FBRztZQUNYLFFBQVEsRUFBRSxPQUFPLENBQUMsSUFBSTtZQUN0QixJQUFJLEVBQUUsSUFBSTtZQUNWLEtBQUssRUFBRSxFQUFFO1lBQ1QsS0FBSyxFQUFFLEVBQUU7U0FDVixDQUFDO1FBQ0YsK0RBQStEO1FBQy9ELE1BQU0sS0FBSyxHQUF1QixDQUFDLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFFaEQseURBQXlEO1FBQ3pELE9BQU8sS0FBSyxDQUFDLE1BQU0sRUFBRTtZQUNuQixpRUFBaUU7WUFDakUsTUFBTSxDQUFDLGFBQWEsRUFBRSxPQUFPLENBQUMsR0FBRyxLQUFLLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDckUsTUFBTSxRQUFRLEdBQVUsb0JBQW9CLENBQUMsYUFBYSxDQUFDLENBQUM7WUFFNUQseUJBQXlCO1lBQ3pCLHlEQUF5RDtZQUV6RCxxREFBcUQ7WUFDckQsaUNBQWlDO1lBQ2pDLHNEQUFzRDtZQUN0RCxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7Z0JBQ3pCLE1BQU0sZ0JBQWdCLEdBQUcsR0FBRyxhQUFhLElBQUksS0FBSyxFQUFFLENBQUM7Z0JBQ3JELDZEQUE2RDtnQkFDN0QsaURBQWlEO2dCQUNqRCxNQUFNLFVBQVUsR0FDZCxPQUFPLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLE9BQU8sSUFBSSxLQUFLLEVBQUUsQ0FBQztnQkFFeEQsSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFO29CQUN6Qix1REFBdUQ7b0JBQ3ZELHdEQUF3RDtvQkFDeEQsTUFBTSx1QkFBdUIsR0FBd0IsU0FBUyxDQUM1RCxvQkFBb0IsRUFDcEIsVUFBVSxDQUNYLENBQUM7b0JBQ0YsTUFBTSxXQUFXLEdBQUcsaUJBQWlCLENBQ25DLGdCQUFnQixFQUNoQix1QkFBdUIsRUFDdkIsV0FBVyxDQUNaLENBQUM7b0JBQ0YsTUFBTSxTQUFTLEdBQUcsSUFBSSxXQUFXLENBQUMsY0FBYyxDQUM5QyxJQUFJLEVBQ0osZ0JBQWdCLEVBQ2hCLFdBQVcsQ0FDWixDQUFDO29CQUVGLGtFQUFrRTtvQkFDbEUsTUFBTSxFQUNKLG1CQUFtQixFQUFFLDBCQUEwQixHQUFHLEtBQUssRUFDdkQsYUFBYSxFQUFFLGlCQUFpQixFQUNoQyxlQUFlLEVBQUUsbUJBQW1CLEVBQ3BDLGdCQUFnQixFQUFFLHNCQUFzQixFQUN4QyxHQUFHLHVCQUF1QixFQUMzQixHQUE0QixTQUFTLENBQ3BDLG9CQUFvQixFQUNwQixVQUFVLENBQ1gsQ0FBQztvQkFDRixJQUFJLDBCQUEwQixHQUFRO3dCQUNwQyxHQUFHLHVCQUF1QjtxQkFDM0IsQ0FBQztvQkFFRixhQUFhO29CQUNiLE1BQU0sYUFBYSxHQUNqQixFQUFFLENBQUM7b0JBQ0wsSUFBSSxpQkFBaUIsRUFBRTt3QkFDckIsTUFBTSxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLE9BQU8sQ0FDdkMsQ0FBQyxDQUFDLFdBQVcsRUFBRSxTQUFTLENBQUMsRUFBRSxFQUFFOzRCQUMzQixhQUFhLENBQUMsV0FBVyxDQUFDLEdBQUcsYUFBYSxDQUFDLFNBQVMsQ0FBQyxDQUFDO3dCQUN4RCxDQUFDLENBQ0YsQ0FBQztxQkFDSDtvQkFFRCxNQUFNLGVBQWUsR0FBZ0MsRUFBRSxDQUFDO29CQUN4RCxJQUFJLG1CQUFtQixJQUFJLG1CQUFtQixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7d0JBQ3pELG1CQUFtQixDQUFDLE9BQU8sQ0FBQyxDQUFDLGtCQUFrQixFQUFFLEVBQUU7NEJBQ2pELE1BQU0sY0FBYyxHQUVoQixFQUFFLENBQUM7NEJBQ1AsSUFBSSxrQkFBa0IsQ0FBQyxjQUFjLEVBQUU7Z0NBQ3JDLE1BQU0sa0JBQWtCLEdBQUcsa0JBQWtCLENBQUMsY0FBYyxDQUFDO2dDQUM3RCxNQUFNLENBQUMsT0FBTyxDQUFDLGtCQUFrQixDQUFDLENBQUMsT0FBTyxDQUN4QyxDQUFDLENBQUMsV0FBVyxFQUFFLFNBQVMsQ0FBQyxFQUFFLEVBQUU7b0NBQzNCLGNBQWMsQ0FBQyxXQUFXLENBQUMsR0FBRyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7Z0NBQ3pELENBQUMsQ0FDRixDQUFDOzZCQUNIOzRCQUVELE1BQU0sRUFBRSxVQUFVLEVBQUUsa0JBQWtCLEVBQUUsR0FBRyxrQkFBa0IsQ0FBQzs0QkFDOUQsZUFBZSxDQUFDLElBQUksQ0FBQztnQ0FDbkIsVUFBVTtnQ0FDVixrQkFBa0I7Z0NBQ2xCLGNBQWM7NkJBQ2YsQ0FBQyxDQUFDO3dCQUNMLENBQUMsQ0FBQyxDQUFDO3FCQUNKO29CQUVELHlCQUF5QjtvQkFDekIsSUFDRSxzQkFBc0I7d0JBQ3RCLHdCQUF3QixDQUFDLHNCQUFzQixDQUFDLEVBQ2hEO3dCQUNBLDBCQUEwQixDQUFDLGdCQUFnQjs0QkFDekMsd0JBQXdCLENBQUMsc0JBQXNCLENBQUMsQ0FBQztxQkFDcEQ7b0JBRUQsMEJBQTBCLENBQUMsYUFBYSxHQUFHLGFBQWEsQ0FBQztvQkFDekQsMEJBQTBCLENBQUMsZUFBZSxHQUFHLGVBQWUsQ0FBQztvQkFDN0QsdURBQXVEO29CQUN2RCxxREFBcUQ7b0JBQ3JELElBQUksMEJBQTBCLElBQUksbUJBQW1CLEVBQUU7d0JBQ3JELDBCQUEwQixDQUFDLGlCQUFpQjs0QkFDMUMsVUFBVSxDQUFDLGlCQUFpQixDQUFDLE1BQU0sQ0FBQzt3QkFDdEMsMEJBQTBCLENBQUMsVUFBVSxHQUFHLGVBQWUsQ0FBQztxQkFDekQ7b0JBRUQsTUFBTSxrQkFBa0IsR0FBRyx3QkFBd0IsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUM7b0JBQ3RFLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUMvQixLQUFLLENBQUMsV0FBVyxFQUFFLEVBQ25CLElBQUksVUFBVSxDQUFDLGlCQUFpQixDQUFDLFNBQVMsRUFBRSxrQkFBa0IsQ0FBQyxFQUMvRCwwQkFBMEIsQ0FDM0IsQ0FBQztvQkFDRixJQUFJLFdBQVcsRUFBRTt3QkFDZixLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxDQUFDO3FCQUN2RDtvQkFDRCxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztvQkFDakMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxHQUFHLFNBQVMsQ0FBQztpQkFDdkM7cUJBQU0sSUFBSSxtQkFBbUIsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUU7b0JBQzlDLDJEQUEyRDtvQkFDM0QsMERBQTBEO29CQUMxRCxjQUFjO2lCQUNmO3FCQUFNO29CQUNMLDhEQUE4RDtvQkFDOUQsb0NBQW9DO29CQUVwQyxNQUFNLFdBQVcsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQztvQkFFbkUsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLGdCQUFnQixFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUM7b0JBRTNDLDhCQUE4QjtvQkFDOUIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7b0JBRWpDLHlDQUF5QztvQkFDekMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxHQUFHO3dCQUNsQixRQUFRLEVBQUUsV0FBVzt3QkFDckIsSUFBSSxFQUFFLGdCQUFnQjt3QkFDdEIsS0FBSyxFQUFFLEVBQUU7d0JBQ1QsS0FBSyxFQUFFLEVBQUU7cUJBQ1YsQ0FBQztpQkFDSDtZQUNILENBQUMsQ0FBQyxDQUFDO1NBQ0o7UUFFRCx5QkFBeUI7UUFDekIsc0JBQXNCO1FBRXRCLHFCQUFxQjtRQUNyQixJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sQ0FBQztRQUN2QixJQUFJLENBQUMsZUFBZSxHQUFHLGFBQWEsQ0FBQztRQUNyQyxJQUFJLENBQUMsTUFBTSxHQUFHLGFBQWEsQ0FBQztRQUM1QixJQUFJLENBQUMsaUJBQWlCLEdBQUcsd0JBQXdCLENBQUM7SUFDcEQsQ0FBQzs7QUFyWUgsMEJBc1lDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbm9kZV9sYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGEtbm9kZWpzXCI7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcblxuLyoqXG4gKiBGb3IgY29weWluZyBzaGFyZWQgY29kZSB0byBhbGwgcGF0aHNcbiAqL1xuaW1wb3J0ICogYXMgZnNlIGZyb20gXCJmcy1leHRyYVwiO1xuaW1wb3J0IHsgQ29yc09wdGlvbnMgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCB7IE5vZGVqc0Z1bmN0aW9uUHJvcHMgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBMYW1iZGFzQnlQYXRoIHtcbiAgW3BhdGg6IHN0cmluZ106IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dMYW1iZGFDb25maWd1cmF0aW9ucyB7XG4gIFtsYW1iZGFCeVBhdGg6IHN0cmluZ106IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHM7XG59XG5cbi8vIFNhbWUgYXMgTW9kZWxPcHRpb25zIGJ1dCBtb2RlbE5hbWUgaXMgcmVxdWlyZWQgKHVzZWQgYXMgSUQpXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNb2RlbE9wdGlvbnMge1xuICByZWFkb25seSBzY2hlbWE6IGFwaWdhdGV3YXkuSnNvblNjaGVtYTtcbiAgcmVhZG9ubHkgbW9kZWxOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbnRlbnRUeXBlPzogc3RyaW5nO1xuICByZWFkb25seSBkZXNjcmlwdGlvbj86IHN0cmluZztcbn1cblxuLy8gU2FtZSBhcyBSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucyBidXQgcmVxdWVzdFZhbGlkYXRvck5hbWUgaXMgcmVxdWlyZWQgKHVzZWQgYXMgSUQpXG5leHBvcnQgaW50ZXJmYWNlIENyb3dSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JOYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHZhbGlkYXRlUmVxdWVzdEJvZHk/OiBib29sZWFuO1xuICByZWFkb25seSB2YWxpZGF0ZVJlcXVlc3RQYXJhbWV0ZXJzPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDcm93TWV0aG9kUmVzcG9uc2Uge1xuICByZWFkb25seSBzdGF0dXNDb2RlOiBzdHJpbmc7XG4gIC8vIFRha2VzIGEgc3RyaW5nIHdoaWNoIGlzIG1hdGNoZWQgd2l0aCB0aGUgbW9kZWxOYW1lXG4gIHJlYWRvbmx5IHJlc3BvbnNlTW9kZWxzPzogeyBbY29udGVudFR5cGU6IHN0cmluZ106IHN0cmluZyB9O1xuICByZWFkb25seSByZXNwb25zZVBhcmFtZXRlcnM/OiB7IFtwYXJhbTogc3RyaW5nXTogYm9vbGVhbiB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RDb25maWd1cmF0aW9uIHtcbiAgLy8gUmVkZWZpbmluZyBNZXRob2RPcHRpb25zIHNpbmNlIE9taXQgaXMgbm90IHN1cHBvcnRlZFxuICByZWFkb25seSBhcGlLZXlSZXF1aXJlZD86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TY29wZXM/OiBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblR5cGU/OiBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlO1xuICByZWFkb25seSBhdXRob3JpemVyPzogYXBpZ2F0ZXdheS5JQXV0aG9yaXplcjtcbiAgcmVhZG9ubHkgbWV0aG9kUmVzcG9uc2VzPzogQ3Jvd01ldGhvZFJlc3BvbnNlW107XG4gIHJlYWRvbmx5IG9wZXJhdGlvbk5hbWU/OiBzdHJpbmc7XG4gIC8vIFRha2VzIGEgc3RyaW5nIHdoaWNoIGlzIG1hdGNoZWQgd2l0aCB0aGUgbW9kZWxOYW1lXG4gIHJlYWRvbmx5IHJlcXVlc3RNb2RlbHM/OiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIHJlYWRvbmx5IHJlcXVlc3RQYXJhbWV0ZXJzPzogeyBbcGFyYW06IHN0cmluZ106IGJvb2xlYW4gfTtcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSByZXF1ZXN0VmFsaWRhdG9yTmFtZVxuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9yPzogc3RyaW5nO1xuICByZWFkb25seSByZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucz86IGFwaWdhdGV3YXkuUmVxdWVzdFZhbGlkYXRvck9wdGlvbnM7XG4gIHJlYWRvbmx5IHVzZUF1dGhvcml6ZXJMYW1iZGE/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RDb25maWd1cmF0aW9ucyB7XG4gIC8vIG1ldGhvZEJ5UGF0aCBzaG91bGQgYmUgbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIFttZXRob2RCeVBhdGg6IHN0cmluZ106IENyb3dNZXRob2RDb25maWd1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IHNvdXJjZURpcmVjdG9yeT86IHN0cmluZztcbiAgcmVhZG9ubHkgc2hhcmVkRGlyZWN0b3J5Pzogc3RyaW5nO1xuICByZWFkb25seSB1c2VBdXRob3JpemVyTGFtYmRhPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYXV0aG9yaXplckRpcmVjdG9yeT86IHN0cmluZztcbiAgLy8gYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGxhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbj86XG4gICAgfCBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzXG4gICAgfCBhbnk7XG4gIC8vIGF1dGhvcml6ZXJDb25maWd1cmF0aW9uIHNob3VsZCBiZSBhcGlnYXRld2F5LlRva2VuQXV0aG9yaXplclByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSB0b2tlbkF1dGhvcml6ZXJDb25maWd1cmF0aW9uPzogYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXJQcm9wcyB8IGFueTtcbiAgcmVhZG9ubHkgY3JlYXRlQXBpS2V5PzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgbG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSBjb3JzT3B0aW9ucz86IENvcnNPcHRpb25zO1xuICAvLyBhcGlHYXR3YXlDb25maWd1cmF0aW9uIHNob3VsZCBiZSBhcGlnYXRld2F5LkxhbWJkYVJlc3RBcGlQcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgcmVhZG9ubHkgYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb24/OiBhcGlnYXRld2F5LlJlc3RBcGlQcm9wcyB8IGFueTtcbiAgcmVhZG9ubHkgYXBpR2F0ZXdheU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxhbWJkYUNvbmZpZ3VyYXRpb25zPzogQ3Jvd0xhbWJkYUNvbmZpZ3VyYXRpb25zO1xuICByZWFkb25seSBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnM/OiB7XG4gICAgW2xhbWJkYVBhdGg6IHN0cmluZ106IGFwaWdhdGV3YXkuTGFtYmRhSW50ZWdyYXRpb25PcHRpb25zO1xuICB9O1xuICByZWFkb25seSBtb2RlbHM/OiBDcm93TW9kZWxPcHRpb25zW107XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JzPzogQ3Jvd1JlcXVlc3RWYWxpZGF0b3JPcHRpb25zW107XG4gIHJlYWRvbmx5IG1ldGhvZENvbmZpZ3VyYXRpb25zPzogQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb25zO1xufVxuXG5pbnRlcmZhY2UgRlNHcmFwaE5vZGUge1xuICByZXNvdXJjZTogYXBpZ2F0ZXdheS5JUmVzb3VyY2U7XG4gIHBhdGg6IHN0cmluZztcbiAgcGF0aHM6IHN0cmluZ1tdO1xuICB2ZXJiczogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBGU0dyYXBoIHtcbiAgW3BhdGg6IHN0cmluZ106IEZTR3JhcGhOb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgQ3Jvd0FwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyBnYXRld2F5ITogYXBpZ2F0ZXdheS5SZXN0QXBpO1xuICBwdWJsaWMgdXNhZ2VQbGFuITogYXBpZ2F0ZXdheS5Vc2FnZVBsYW47XG4gIHB1YmxpYyBhdXRob3JpemVyITogYXBpZ2F0ZXdheS5JQXV0aG9yaXplcjtcbiAgcHVibGljIGF1dGhvcml6ZXJMYW1iZGEhOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbjtcbiAgcHVibGljIGxhbWJkYUxheWVyITogbGFtYmRhLkxheWVyVmVyc2lvbiB8IHVuZGVmaW5lZDtcbiAgcHVibGljIGxhbWJkYUZ1bmN0aW9ucyE6IExhbWJkYXNCeVBhdGg7XG4gIHB1YmxpYyBtb2RlbHMhOiB7IFttb2RlbE5hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH07XG4gIHB1YmxpYyByZXF1ZXN0VmFsaWRhdG9ycyE6IHtcbiAgICBbcmVxdWVzdFZhbGlkYXRvcnNOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklSZXF1ZXN0VmFsaWRhdG9yO1xuICB9O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQ3Jvd0FwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vIFB1bGxpbmcgb3V0IHByb3BzXG4gICAgY29uc3Qge1xuICAgICAgc291cmNlRGlyZWN0b3J5ID0gXCJzcmNcIixcbiAgICAgIHNoYXJlZERpcmVjdG9yeSA9IFwic2hhcmVkXCIsXG4gICAgICB1c2VBdXRob3JpemVyTGFtYmRhID0gZmFsc2UsXG4gICAgICBhdXRob3JpemVyRGlyZWN0b3J5ID0gXCJhdXRob3JpemVyXCIsXG4gICAgICBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgdG9rZW5BdXRob3JpemVyQ29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgY3JlYXRlQXBpS2V5ID0gZmFsc2UsXG4gICAgICBsb2dSZXRlbnRpb24gPSBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICBhcGlHYXRld2F5Q29uZmlndXJhdGlvbiA9IHt9LFxuICAgICAgYXBpR2F0ZXdheU5hbWUgPSBcImNyb3ctYXBpXCIsXG4gICAgICBsYW1iZGFDb25maWd1cmF0aW9ucyA9IHt9LFxuICAgICAgbGFtYmRhSW50ZWdyYXRpb25PcHRpb25zID0ge30sXG4gICAgICBtb2RlbHMgPSBbXSxcbiAgICAgIHJlcXVlc3RWYWxpZGF0b3JzID0gW10sXG4gICAgICBtZXRob2RDb25maWd1cmF0aW9ucyA9IHt9LFxuICAgICAgY29yc09wdGlvbnMgPSBudWxsXG4gICAgfSA9IHByb3BzO1xuXG4gICAgLy8gSW5pdGlhbGl6aW5nIGNvbnN0YW50c1xuICAgIGNvbnN0IExBTUJEQV9SVU5USU1FID0gbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1g7XG4gICAgY29uc3QgU1BFQ0lBTF9ESVJFQ1RPUklFUyA9IFtzaGFyZWREaXJlY3RvcnksIGF1dGhvcml6ZXJEaXJlY3RvcnldO1xuXG4gICAgLy8gSGVscGVycyBmdW5jdGlvbnMgZm9yIGNvbnN0cnVjdG9yXG5cbiAgICAvLyBQcmVwYXJlcyBkZWZhdWx0IExhbWJkYSBwcm9wcyBhbmQgb3ZlcnJpZGVzIHRoZW0gd2l0aCB1c2VyIGlucHV0XG4gICAgZnVuY3Rpb24gYnVuZGxlTGFtYmRhUHJvcHMoXG4gICAgICBjb2RlUGF0aDogc3RyaW5nLFxuICAgICAgdXNlckNvbmZpZ3VyYXRpb246IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHMsXG4gICAgICBzaGFyZWRMYXllcjogbGFtYmRhLkxheWVyVmVyc2lvbiB8IHVuZGVmaW5lZFxuICAgICkge1xuICAgICAgbGV0IGxheWVycztcbiAgICAgIGlmIChzaGFyZWRMYXllcikge1xuICAgICAgICBjb25zdCB7IGxheWVyczogdXNlckxheWVycyA9IFtdIH0gPSB1c2VyQ29uZmlndXJhdGlvbjtcbiAgICAgICAgbGF5ZXJzID0gW3NoYXJlZExheWVyLCAuLi51c2VyTGF5ZXJzXTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGVmYXVsdFByb3BzID0ge1xuICAgICAgICBydW50aW1lOiBMQU1CREFfUlVOVElNRSxcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KGNvZGVQYXRoKSxcbiAgICAgICAgZW50cnk6IGAke2NvZGVQYXRofS9pbmRleC5qc2AsXG4gICAgICAgIGhhbmRsZXI6IFwiaGFuZGxlclwiLFxuICAgICAgICBsb2dSZXRlbnRpb25cbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IGxhbWJkYVByb3BzID0ge1xuICAgICAgICAuLi5kZWZhdWx0UHJvcHMsXG4gICAgICAgIC4uLnVzZXJDb25maWd1cmF0aW9uLCAvLyBMZXQgdXNlciBjb25maWd1cmF0aW9uIG92ZXJyaWRlIGFueXRoaW5nIGV4Y2VwdCBsYXllcnNcbiAgICAgICAgbGF5ZXJzXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gbGFtYmRhUHJvcHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0Q29uZmlnKFxuICAgICAgY29uZmlndXJhdGlvbnM6IENyb3dNZXRob2RDb25maWd1cmF0aW9ucyB8IENyb3dMYW1iZGFDb25maWd1cmF0aW9ucyxcbiAgICAgIG5ld0FwaVBhdGg6IHN0cmluZ1xuICAgICk6IGFueSB7XG4gICAgICAvLyBpZiBkaXJlY3QgbWF0Y2ggcmV0dXJuIHJpZ2h0IGF3YXlcbiAgICAgIGlmIChjb25maWd1cmF0aW9uc1tuZXdBcGlQYXRoXSkge1xuICAgICAgICByZXR1cm4gY29uZmlndXJhdGlvbnNbbmV3QXBpUGF0aF07XG4gICAgICB9XG5cbiAgICAgIC8vIGNoZWNrIGFsbCByb3V0ZSB3aWxkIGNhcmQgb3B0aW9ucyBmb3IgbWF0Y2hpbmcgY29uZmlnc1xuICAgICAgbGV0IGJhc2VSb3V0ZTogc3RyaW5nID0gXCJcIjtcbiAgICAgIGNvbnN0IG1hdGNoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBuZXdBcGlQYXRoXG4gICAgICAgIC5zcGxpdChcIi9cIilcbiAgICAgICAgLm1hcCgoc2VnbWVudCkgPT4ge1xuICAgICAgICAgIGlmIChzZWdtZW50KSB7XG4gICAgICAgICAgICBiYXNlUm91dGUgKz0gYC8ke3NlZ21lbnR9YDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGAke2Jhc2VSb3V0ZX0vKmA7XG4gICAgICAgIH0pXG4gICAgICAgIC5maW5kKCh3aWxkY2FyZCkgPT4gISFjb25maWd1cmF0aW9uc1t3aWxkY2FyZF0pO1xuXG4gICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgcmV0dXJuIGNvbmZpZ3VyYXRpb25zW21hdGNoXTtcbiAgICAgIH1cblxuICAgICAgLy8gcmV0dXJucyBlbXB0eSBjb25maWdcbiAgICAgIHJldHVybiB7fTtcbiAgICB9XG5cbiAgICAvLyBSZXR1cm5zIGNoaWxkIGRpcmVjdG9yaWVzIGdpdmVuIHRoZSBwYXRoIG9mIGEgcGFyZW50XG4gICAgZnVuY3Rpb24gZ2V0RGlyZWN0b3J5Q2hpbGRyZW4ocGFyZW50RGlyZWN0b3J5OiBzdHJpbmcpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGRpcmVjdG9yaWVzID0gZnNlXG4gICAgICAgICAgLnJlYWRkaXJTeW5jKHBhcmVudERpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pXG4gICAgICAgICAgLmZpbHRlcigoZGlyZW50OiBhbnkpID0+IGRpcmVudC5pc0RpcmVjdG9yeSgpKVxuICAgICAgICAgIC5tYXAoKGRpcmVudDogYW55KSA9PiBkaXJlbnQubmFtZSk7XG4gICAgICAgIHJldHVybiBkaXJlY3RvcmllcztcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKipcbiAgICAgICAgICogVGhlIG9ubHkgdGltZSBJIGhhdmUgcnVuIGludG8gdGhpcyB3YXMgd2hlbiB0aGUgc3JjLyBkaXJlY3RvcnlcbiAgICAgICAgICogd2FzIGVtcHR5LlxuICAgICAgICAgKiBJZiBpdCBpcyBlbXB0eSwgbGV0IENESyB0cmVlIHZhbGlkYXRpb24gdGVsbCB1c2VyIHRoYXQgdGhlXG4gICAgICAgICAqIFJFU1QgQVBJIGRvZXMgbm90IGhhdmUgYW55IG1ldGhvZHMuXG4gICAgICAgICAqL1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cblxuICAgIC8vIEFQSSBHYXRld2F5IGxvZyBncm91cFxuICAgIGNvbnN0IGdhdGV3YXlMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiYXBpLWFjY2Vzcy1sb2dzXCIsIHtcbiAgICAgIHJldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLXG4gICAgfSk7XG5cbiAgICAvLyBUaGUgQVBJIEdhdGV3YXkgaXRzZWxmXG4gICAgY29uc3QgZ2F0ZXdheSA9IG5ldyBhcGlnYXRld2F5LlJlc3RBcGkodGhpcywgYXBpR2F0ZXdheU5hbWUsIHtcbiAgICAgIGRlcGxveTogdHJ1ZSxcbiAgICAgIGRlcGxveU9wdGlvbnM6IHtcbiAgICAgICAgbG9nZ2luZ0xldmVsOiBhcGlnYXRld2F5Lk1ldGhvZExvZ2dpbmdMZXZlbC5FUlJPUixcbiAgICAgICAgYWNjZXNzTG9nRGVzdGluYXRpb246IG5ldyBhcGlnYXRld2F5LkxvZ0dyb3VwTG9nRGVzdGluYXRpb24oXG4gICAgICAgICAgZ2F0ZXdheUxvZ0dyb3VwXG4gICAgICAgIClcbiAgICAgIH0sXG4gICAgICBhcGlLZXlTb3VyY2VUeXBlOiBjcmVhdGVBcGlLZXlcbiAgICAgICAgPyBhcGlnYXRld2F5LkFwaUtleVNvdXJjZVR5cGUuSEVBREVSXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgZGVmYXVsdENvcnNQcmVmbGlnaHRPcHRpb25zOiBjb3JzT3B0aW9ucyA/IGNvcnNPcHRpb25zIDogdW5kZWZpbmVkLFxuICAgICAgLi4uYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb25cbiAgICB9KTtcblxuICAgIGNvbnN0IGNyZWF0ZWRNb2RlbHM6IHsgW21vZGVsTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfSA9IHt9O1xuICAgIG1vZGVscy5mb3JFYWNoKChtb2RlbDogQ3Jvd01vZGVsT3B0aW9ucykgPT4ge1xuICAgICAgLy8gbW9kZWxOYW1lIGlzIHVzZWQgYXMgSUQgYW5kIGNhbiBub3cgYmUgdXNlZCBmb3IgcmVmZXJlbmNpbmcgbW9kZWwgaW4gbWV0aG9kIG9wdGlvbnNcbiAgICAgIGNyZWF0ZWRNb2RlbHNbbW9kZWwubW9kZWxOYW1lXSA9IGdhdGV3YXkuYWRkTW9kZWwobW9kZWwubW9kZWxOYW1lLCBtb2RlbCk7XG4gICAgfSk7XG4gICAgY29uc3QgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzOiB7XG4gICAgICBbcmVxdWVzdFZhbGlkYXRvcnNOYW1lOiBzdHJpbmddOiBhcGlnYXRld2F5LklSZXF1ZXN0VmFsaWRhdG9yO1xuICAgIH0gPSB7fTtcbiAgICByZXF1ZXN0VmFsaWRhdG9ycy5mb3JFYWNoKFxuICAgICAgKHJlcXVlc3RWYWxpZGF0b3I6IENyb3dSZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucykgPT4ge1xuICAgICAgICAvLyByZXF1ZXN0VmFsaWRhdG9yTmFtZSBpcyB1c2VkIGFzIElEIGFuZCBjYW4gbm93IGJlIHVzZWQgZm9yIHJlZmVyZW5jaW5nIG1vZGVsIGluIG1ldGhvZCBvcHRpb25zXG4gICAgICAgIGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9yc1tyZXF1ZXN0VmFsaWRhdG9yLnJlcXVlc3RWYWxpZGF0b3JOYW1lXSA9XG4gICAgICAgICAgZ2F0ZXdheS5hZGRSZXF1ZXN0VmFsaWRhdG9yKFxuICAgICAgICAgICAgcmVxdWVzdFZhbGlkYXRvci5yZXF1ZXN0VmFsaWRhdG9yTmFtZSxcbiAgICAgICAgICAgIHJlcXVlc3RWYWxpZGF0b3JcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgICk7XG5cbiAgICAvLyBDcmVhdGUgQVBJIGtleSBpZiBkZXNpcmVkXG4gICAgaWYgKGNyZWF0ZUFwaUtleSkge1xuICAgICAgY29uc3QgYXBpS2V5ID0gZ2F0ZXdheS5hZGRBcGlLZXkoXCJhcGkta2V5XCIpO1xuICAgICAgY29uc3QgdXNhZ2VQbGFuID0gbmV3IGFwaWdhdGV3YXkuVXNhZ2VQbGFuKHRoaXMsIFwidXNhZ2UtcGxhblwiLCB7XG4gICAgICAgIHRocm90dGxlOiB7XG4gICAgICAgICAgYnVyc3RMaW1pdDogNTAwMCxcbiAgICAgICAgICByYXRlTGltaXQ6IDEwMDAwXG4gICAgICAgIH0sXG4gICAgICAgIGFwaVN0YWdlczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIGFwaTogZ2F0ZXdheSxcbiAgICAgICAgICAgIHN0YWdlOiBnYXRld2F5LmRlcGxveW1lbnRTdGFnZVxuICAgICAgICAgIH1cbiAgICAgICAgXVxuICAgICAgfSk7XG4gICAgICB1c2FnZVBsYW4uYWRkQXBpS2V5KGFwaUtleSk7XG4gICAgICB0aGlzLnVzYWdlUGxhbiA9IHVzYWdlUGxhbjtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGxheWVyIG91dCBvZiBzaGFyZWQgZGlyZWN0b3J5IGlmIGl0IGV4aXN0c1xuICAgIGNvbnN0IHNvdXJjZVNoYXJlZERpcmVjdG9yeSA9IGAke3NvdXJjZURpcmVjdG9yeX0vJHtzaGFyZWREaXJlY3Rvcnl9YDtcbiAgICBsZXQgc2hhcmVkTGF5ZXI6IGxhbWJkYS5MYXllclZlcnNpb24gfCB1bmRlZmluZWQ7XG4gICAgaWYgKGZzZS5leGlzdHNTeW5jKHNvdXJjZVNoYXJlZERpcmVjdG9yeSkpIHtcbiAgICAgIHNoYXJlZExheWVyID0gbmV3IGxhbWJkYS5MYXllclZlcnNpb24odGhpcywgXCJzaGFyZWQtbGF5ZXJcIiwge1xuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoc291cmNlU2hhcmVkRGlyZWN0b3J5KSxcbiAgICAgICAgY29tcGF0aWJsZVJ1bnRpbWVzOiBbTEFNQkRBX1JVTlRJTUVdLFxuICAgICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5sYW1iZGFMYXllciA9IHNoYXJlZExheWVyO1xuICAgIH1cblxuICAgIC8vIENyZWF0ZSBMYW1iZGEgYXV0aG9yaXplciB0byBiZSB1c2VkIGluIHN1YnNlcXVlbnQgTWV0aG9kc1xuICAgIGxldCB0b2tlbkF1dGhvcml6ZXI6IGFwaWdhdGV3YXkuSUF1dGhvcml6ZXI7XG4gICAgaWYgKHVzZUF1dGhvcml6ZXJMYW1iZGEpIHtcbiAgICAgIGNvbnN0IGZ1bGxBdXRob3JpemVyRGlyZWN0b3J5ID0gYCR7c291cmNlRGlyZWN0b3J5fS8ke2F1dGhvcml6ZXJEaXJlY3Rvcnl9YDtcblxuICAgICAgY29uc3QgYXV0aG9yaXplckxhbWJkYVByb3BzID0gYnVuZGxlTGFtYmRhUHJvcHMoXG4gICAgICAgIGZ1bGxBdXRob3JpemVyRGlyZWN0b3J5LFxuICAgICAgICBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbixcbiAgICAgICAgc2hhcmVkTGF5ZXJcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGF1dGhvcml6ZXJMYW1iZGEgPSBuZXcgbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb24oXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwiYXV0aG9yaXplci1sYW1iZGFcIixcbiAgICAgICAgYXV0aG9yaXplckxhbWJkYVByb3BzXG4gICAgICApO1xuICAgICAgdGhpcy5hdXRob3JpemVyTGFtYmRhID0gYXV0aG9yaXplckxhbWJkYTtcblxuICAgICAgY29uc3QgYnVuZGxlZFRva2VuQXV0aENvbmZpZyA9IHtcbiAgICAgICAgaGFuZGxlcjogYXV0aG9yaXplckxhbWJkYSxcbiAgICAgICAgcmVzdWx0c0NhY2hlVHRsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzNjAwKSxcbiAgICAgICAgLi4udG9rZW5BdXRob3JpemVyQ29uZmlndXJhdGlvblxuICAgICAgfTtcbiAgICAgIHRva2VuQXV0aG9yaXplciA9IG5ldyBhcGlnYXRld2F5LlRva2VuQXV0aG9yaXplcihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgXCJ0b2tlbi1hdXRob3JpemVyXCIsXG4gICAgICAgIGJ1bmRsZWRUb2tlbkF1dGhDb25maWdcbiAgICAgICk7XG4gICAgICB0aGlzLmF1dGhvcml6ZXIgPSB0b2tlbkF1dGhvcml6ZXI7XG4gICAgfVxuXG4gICAgLy8gVGltZSB0byBzdGFydCB3YWxraW5nIHRoZSBkaXJlY3Rvcmllc1xuICAgIGNvbnN0IHJvb3QgPSBzb3VyY2VEaXJlY3Rvcnk7XG4gICAgY29uc3QgdmVyYnMgPSBbXCJnZXRcIiwgXCJwb3N0XCIsIFwicHV0XCIsIFwiZGVsZXRlXCJdO1xuICAgIGNvbnN0IGdyYXBoOiBGU0dyYXBoID0ge307XG4gICAgY29uc3QgbGFtYmRhc0J5UGF0aDogTGFtYmRhc0J5UGF0aCA9IHt9O1xuXG4gICAgLy8gSW5pdGlhbGl6ZSB3aXRoIHJvb3RcbiAgICBncmFwaFtcIi9cIl0gPSB7XG4gICAgICByZXNvdXJjZTogZ2F0ZXdheS5yb290LFxuICAgICAgcGF0aDogcm9vdCxcbiAgICAgIHBhdGhzOiBbXSxcbiAgICAgIHZlcmJzOiBbXVxuICAgIH07XG4gICAgLy8gRmlyc3QgZWxlbWVudCBpbiB0dXBsZSBpcyBkaXJlY3RvcnkgcGF0aCwgc2Vjb25kIGlzIEFQSSBwYXRoXG4gICAgY29uc3Qgbm9kZXM6IFtzdHJpbmcsIHN0cmluZ11bXSA9IFtbcm9vdCwgXCIvXCJdXTtcblxuICAgIC8vIEJGUyB0aGF0IGNyZWF0ZXMgQVBJIEdhdGV3YXkgc3RydWN0dXJlIHVzaW5nIGFkZE1ldGhvZFxuICAgIHdoaWxlIChub2Rlcy5sZW5ndGgpIHtcbiAgICAgIC8vIFRoZSBgfHwgWyd0eXBlJywgJ3NjcmlwdCddYCBwaWVjZSBpcyBuZWVkZWQgb3IgVFMgdGhyb3dzIGEgZml0XG4gICAgICBjb25zdCBbZGlyZWN0b3J5UGF0aCwgYXBpUGF0aF0gPSBub2Rlcy5zaGlmdCgpIHx8IFtcInR5cGVcIiwgXCJzY3JpcHRcIl07XG4gICAgICBjb25zdCBjaGlsZHJlbjogYW55W10gPSBnZXREaXJlY3RvcnlDaGlsZHJlbihkaXJlY3RvcnlQYXRoKTtcblxuICAgICAgLy8gRm9yIGRlYnVnZ2luZyBwdXJwb3Nlc1xuICAgICAgLy8gY29uc29sZS5sb2coYCR7YXBpUGF0aH0ncyBjaGlsZHJlbiBhcmU6ICR7Y2hpbGRyZW59YCk7XG5cbiAgICAgIC8vIERvbid0IGhhdmUgdG8gd29ycnkgYWJvdXQgcHJldmlvdXNseSB2aXNpdGVkIG5vZGVzXG4gICAgICAvLyBzaW5jZSB0aGlzIGlzIGEgZmlsZSBzdHJ1Y3R1cmVcbiAgICAgIC8vIC4uLnVubGVzcyB0aGVyZSBhcmUgc3ltbGlua3M/IEhhdmVuJ3QgcnVuIGludG8gdGhhdFxuICAgICAgY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHtcbiAgICAgICAgY29uc3QgbmV3RGlyZWN0b3J5UGF0aCA9IGAke2RpcmVjdG9yeVBhdGh9LyR7Y2hpbGR9YDtcbiAgICAgICAgLy8gSWYgd2UncmUgb24gdGhlIHJvb3QgcGF0aCwgZG9uJ3Qgc2VwYXJhdGUgd2l0aCBhIHNsYXNoICgvKVxuICAgICAgICAvLyAgIGJlY2F1c2UgaXQgZW5kcyB1cCBsb29raW5nIGxpa2UgLy9jaGlsZC1wYXRoXG4gICAgICAgIGNvbnN0IG5ld0FwaVBhdGggPVxuICAgICAgICAgIGFwaVBhdGggPT09IFwiL1wiID8gYC8ke2NoaWxkfWAgOiBgJHthcGlQYXRofS8ke2NoaWxkfWA7XG5cbiAgICAgICAgaWYgKHZlcmJzLmluY2x1ZGVzKGNoaWxkKSkge1xuICAgICAgICAgIC8vIElmIGRpcmVjdG9yeSBpcyBhIHZlcmIsIHdlIGRvbid0IHRyYXZlcnNlIGl0IGFueW1vcmVcbiAgICAgICAgICAvLyAgIGFuZCBuZWVkIHRvIGNyZWF0ZSBhbiBBUEkgR2F0ZXdheSBtZXRob2QgYW5kIExhbWJkYVxuICAgICAgICAgIGNvbnN0IHVzZXJMYW1iZGFDb25maWd1cmF0aW9uOiBOb2RlanNGdW5jdGlvblByb3BzID0gZ2V0Q29uZmlnKFxuICAgICAgICAgICAgbGFtYmRhQ29uZmlndXJhdGlvbnMsXG4gICAgICAgICAgICBuZXdBcGlQYXRoXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBsYW1iZGFQcm9wcyA9IGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgICAgICAgbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIHVzZXJMYW1iZGFDb25maWd1cmF0aW9uLFxuICAgICAgICAgICAgc2hhcmVkTGF5ZXJcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbnN0IG5ld0xhbWJkYSA9IG5ldyBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvbihcbiAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICBuZXdEaXJlY3RvcnlQYXRoLFxuICAgICAgICAgICAgbGFtYmRhUHJvcHNcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgLy8gUHVsbCBvdXQgdXNlQXV0aG9yaXplckxhbWJkYSB2YWx1ZSBhbmQgdGhlIHR3ZWFrZWQgbW9kZWwgdmFsdWVzXG4gICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgdXNlQXV0aG9yaXplckxhbWJkYTogYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyZWQgPSBmYWxzZSxcbiAgICAgICAgICAgIHJlcXVlc3RNb2RlbHM6IGNyb3dSZXF1ZXN0TW9kZWxzLFxuICAgICAgICAgICAgbWV0aG9kUmVzcG9uc2VzOiBjcm93TWV0aG9kUmVzcG9uc2VzLFxuICAgICAgICAgICAgcmVxdWVzdFZhbGlkYXRvcjogcmVxdWVzdFZhbGlkYXRvclN0cmluZyxcbiAgICAgICAgICAgIC4uLnVzZXJNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgfTogQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb24gPSBnZXRDb25maWcoXG4gICAgICAgICAgICBtZXRob2RDb25maWd1cmF0aW9ucyxcbiAgICAgICAgICAgIG5ld0FwaVBhdGhcbiAgICAgICAgICApO1xuICAgICAgICAgIGxldCBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbjogYW55ID0ge1xuICAgICAgICAgICAgLi4udXNlck1ldGhvZENvbmZpZ3VyYXRpb25cbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgLy8gTWFwIG1vZGVsc1xuICAgICAgICAgIGNvbnN0IHJlcXVlc3RNb2RlbHM6IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbCB9ID1cbiAgICAgICAgICAgIHt9O1xuICAgICAgICAgIGlmIChjcm93UmVxdWVzdE1vZGVscykge1xuICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoY3Jvd1JlcXVlc3RNb2RlbHMpLmZvckVhY2goXG4gICAgICAgICAgICAgIChbY29udGVudFR5cGUsIG1vZGVsTmFtZV0pID0+IHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0TW9kZWxzW2NvbnRlbnRUeXBlXSA9IGNyZWF0ZWRNb2RlbHNbbW9kZWxOYW1lXTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBtZXRob2RSZXNwb25zZXM6IGFwaWdhdGV3YXkuTWV0aG9kUmVzcG9uc2VbXSA9IFtdO1xuICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2VzICYmIGNyb3dNZXRob2RSZXNwb25zZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY3Jvd01ldGhvZFJlc3BvbnNlcy5mb3JFYWNoKChjcm93TWV0aG9kUmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VNb2RlbHM6IHtcbiAgICAgICAgICAgICAgICBbY29udGVudFR5cGU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsO1xuICAgICAgICAgICAgICB9ID0ge307XG4gICAgICAgICAgICAgIGlmIChjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjcm93UmVzcG9uc2VNb2RlbHMgPSBjcm93TWV0aG9kUmVzcG9uc2UucmVzcG9uc2VNb2RlbHM7XG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMoY3Jvd1Jlc3BvbnNlTW9kZWxzKS5mb3JFYWNoKFxuICAgICAgICAgICAgICAgICAgKFtjb250ZW50VHlwZSwgbW9kZWxOYW1lXSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1tjb250ZW50VHlwZV0gPSBjcmVhdGVkTW9kZWxzW21vZGVsTmFtZV07XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHsgc3RhdHVzQ29kZSwgcmVzcG9uc2VQYXJhbWV0ZXJzIH0gPSBjcm93TWV0aG9kUmVzcG9uc2U7XG4gICAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICBzdGF0dXNDb2RlLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVycyxcbiAgICAgICAgICAgICAgICByZXNwb25zZU1vZGVsc1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEZpbmQgcmVxdWVzdCB2YWxpZGF0b3JcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yU3RyaW5nICYmXG4gICAgICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ11cbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLnJlcXVlc3RWYWxpZGF0b3IgPVxuICAgICAgICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvclN0cmluZ107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ucmVxdWVzdE1vZGVscyA9IHJlcXVlc3RNb2RlbHM7XG4gICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24ubWV0aG9kUmVzcG9uc2VzID0gbWV0aG9kUmVzcG9uc2VzO1xuICAgICAgICAgIC8vIElmIHRoaXMgbWV0aG9kIHNob3VsZCBiZSBiZWhpbmQgYW4gYXV0aG9yaXplciBMYW1iZGFcbiAgICAgICAgICAvLyAgIGNvbnN0cnVjdCB0aGUgbWV0aG9kQ29uZmlndXJhdGlvbiBvYmplY3QgYXMgc3VjaFxuICAgICAgICAgIGlmIChhdXRob3JpemVyTGFtYmRhQ29uZmlndXJlZCAmJiB1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbi5hdXRob3JpemF0aW9uVHlwZSA9XG4gICAgICAgICAgICAgIGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ1VTVE9NO1xuICAgICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24uYXV0aG9yaXplciA9IHRva2VuQXV0aG9yaXplcjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBpbnRlZ3JhdGlvbk9wdGlvbnMgPSBsYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnNbbmV3QXBpUGF0aF0gfHwge307XG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucmVzb3VyY2UuYWRkTWV0aG9kKFxuICAgICAgICAgICAgY2hpbGQudG9VcHBlckNhc2UoKSxcbiAgICAgICAgICAgIG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKG5ld0xhbWJkYSwgaW50ZWdyYXRpb25PcHRpb25zKSxcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAoY29yc09wdGlvbnMpIHtcbiAgICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnJlc291cmNlLmFkZENvcnNQcmVmbGlnaHQoY29yc09wdGlvbnMpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBncmFwaFthcGlQYXRoXS52ZXJicy5wdXNoKGNoaWxkKTtcbiAgICAgICAgICBsYW1iZGFzQnlQYXRoW25ld0FwaVBhdGhdID0gbmV3TGFtYmRhO1xuICAgICAgICB9IGVsc2UgaWYgKFNQRUNJQUxfRElSRUNUT1JJRVMuaW5jbHVkZXMoY2hpbGQpKSB7XG4gICAgICAgICAgLy8gVGhlIHNwZWNpYWwgZGlyZWN0b3JpZXMgc2hvdWxkIG5vdCByZXN1bHQgaW4gYW4gQVBJIHBhdGhcbiAgICAgICAgICAvLyBUaGlzIG1lYW5zIHRoZSBBUEkgYWxzbyBjYW5ub3QgaGF2ZSBhIHJlc291cmNlIHdpdGggdGhlXG4gICAgICAgICAgLy8gICBzYW1lIG5hbWVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBJZiBkaXJlY3RvcnkgaXMgbm90IGEgdmVyYiwgY3JlYXRlIG5ldyBBUEkgR2F0ZXdheSByZXNvdXJjZVxuICAgICAgICAgIC8vICAgZm9yIHVzZSBieSB2ZXJiIGRpcmVjdG9yeSBsYXRlclxuXG4gICAgICAgICAgY29uc3QgbmV3UmVzb3VyY2UgPSBncmFwaFthcGlQYXRoXS5yZXNvdXJjZS5yZXNvdXJjZUZvclBhdGgoY2hpbGQpO1xuXG4gICAgICAgICAgbm9kZXMucHVzaChbbmV3RGlyZWN0b3J5UGF0aCwgbmV3QXBpUGF0aF0pO1xuXG4gICAgICAgICAgLy8gQWRkIGNoaWxkIHRvIHBhcmVudCdzIHBhdGhzXG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0ucGF0aHMucHVzaChjaGlsZCk7XG5cbiAgICAgICAgICAvLyBJbml0aWFsaXplIGdyYXBoIG5vZGUgdG8gaW5jbHVkZSBjaGlsZFxuICAgICAgICAgIGdyYXBoW25ld0FwaVBhdGhdID0ge1xuICAgICAgICAgICAgcmVzb3VyY2U6IG5ld1Jlc291cmNlLFxuICAgICAgICAgICAgcGF0aDogbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIHBhdGhzOiBbXSxcbiAgICAgICAgICAgIHZlcmJzOiBbXVxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAvLyBjb25zb2xlLmxvZyhncmFwaCk7XG5cbiAgICAvLyBFeHBvc2UgQVBJIEdhdGV3YXlcbiAgICB0aGlzLmdhdGV3YXkgPSBnYXRld2F5O1xuICAgIHRoaXMubGFtYmRhRnVuY3Rpb25zID0gbGFtYmRhc0J5UGF0aDtcbiAgICB0aGlzLm1vZGVscyA9IGNyZWF0ZWRNb2RlbHM7XG4gICAgdGhpcy5yZXF1ZXN0VmFsaWRhdG9ycyA9IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9ycztcbiAgfVxufVxuIl19