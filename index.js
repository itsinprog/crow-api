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
        const { sourceDirectory = "src", sharedDirectory = "shared", useAuthorizerLambda = false, useAuthorizerLambdaOnAllRoutes = false, authorizerDirectory = "authorizer", authorizerLambdaConfiguration = {}, tokenAuthorizerConfiguration = {}, createApiKey = false, logRetention = logs.RetentionDays.ONE_WEEK, apiGatewayConfiguration = {}, apiGatewayName = "crow-api", lambdaConfigurations = {}, lambdaIntegrationOptions = {}, models = [], requestValidators = [], methodConfigurations = {}, corsOptions = null } = props;
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
                    if (authorizerLambdaConfigured &&
                        (useAuthorizerLambdaOnAllRoutes || useAuthorizerLambda)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBdUM7QUFDdkMsaURBQWlEO0FBQ2pELDZEQUE2RDtBQUM3RCx5REFBeUQ7QUFDekQsNkNBQTZDO0FBRTdDOztHQUVHO0FBQ0gsZ0NBQWdDOzs7O0FBc0doQyxNQUFhLE9BQVEsU0FBUSxzQkFBUzs7OztJQWFwQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQW1CO1FBQzNELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsb0JBQW9CO1FBQ3BCLE1BQU0sRUFDSixlQUFlLEdBQUcsS0FBSyxFQUN2QixlQUFlLEdBQUcsUUFBUSxFQUMxQixtQkFBbUIsR0FBRyxLQUFLLEVBQzNCLDhCQUE4QixHQUFHLEtBQUssRUFDdEMsbUJBQW1CLEdBQUcsWUFBWSxFQUNsQyw2QkFBNkIsR0FBRyxFQUFFLEVBQ2xDLDRCQUE0QixHQUFHLEVBQUUsRUFDakMsWUFBWSxHQUFHLEtBQUssRUFDcEIsWUFBWSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUSxFQUMxQyx1QkFBdUIsR0FBRyxFQUFFLEVBQzVCLGNBQWMsR0FBRyxVQUFVLEVBQzNCLG9CQUFvQixHQUFHLEVBQUUsRUFDekIsd0JBQXdCLEdBQUcsRUFBRSxFQUM3QixNQUFNLEdBQUcsRUFBRSxFQUNYLGlCQUFpQixHQUFHLEVBQUUsRUFDdEIsb0JBQW9CLEdBQUcsRUFBRSxFQUN6QixXQUFXLEdBQUcsSUFBSSxFQUNuQixHQUFHLEtBQUssQ0FBQztRQUVWLHlCQUF5QjtRQUN6QixNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQztRQUNsRCxNQUFNLG1CQUFtQixHQUFHLENBQUMsZUFBZSxFQUFFLG1CQUFtQixDQUFDLENBQUM7UUFFbkUsb0NBQW9DO1FBRXBDLG1FQUFtRTtRQUNu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TyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztvQkFFakMseUNBQXlDO29CQUN6QyxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUc7d0JBQ2xCLFFBQVEsRUFBRSxXQUFXO3dCQUNyQixJQUFJLEVBQUUsZ0JBQWdCO3dCQUN0QixLQUFLLEVBQUUsRUFBRTt3QkFDVCxLQUFLLEVBQUUsRUFBRTtxQkFDVixDQUFDO2lCQUNIO1lBQ0gsQ0FBQyxDQUFDLENBQUM7U0FDSjtRQUVELHlCQUF5QjtRQUN6QixzQkFBc0I7UUFFdEIscUJBQXFCO1FBQ3JCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxlQUFlLEdBQUcsYUFBYSxDQUFDO1FBQ3JDLElBQUksQ0FBQyxNQUFNLEdBQUcsYUFBYSxDQUFDO1FBQzVCLElBQUksQ0FBQyxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztJQUNwRCxDQUFDOztBQXpZSCwwQkEwWUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBub2RlX2xhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ub2RlanNcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuXG4vKipcbiAqIEZvciBjb3B5aW5nIHNoYXJlZCBjb2RlIHRvIGFsbCBwYXRoc1xuICovXG5pbXBvcnQgKiBhcyBmc2UgZnJvbSBcImZzLWV4dHJhXCI7XG5pbXBvcnQgeyBDb3JzT3B0aW9ucyB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0IHsgTm9kZWpzRnVuY3Rpb25Qcm9wcyB9IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIExhbWJkYXNCeVBhdGgge1xuICBbcGF0aDogc3RyaW5nXTogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd0xhbWJkYUNvbmZpZ3VyYXRpb25zIHtcbiAgW2xhbWJkYUJ5UGF0aDogc3RyaW5nXTogbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wcztcbn1cblxuLy8gU2FtZSBhcyBNb2RlbE9wdGlvbnMgYnV0IG1vZGVsTmFtZSBpcyByZXF1aXJlZCAodXNlZCBhcyBJRClcbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01vZGVsT3B0aW9ucyB7XG4gIHJlYWRvbmx5IHNjaGVtYTogYXBpZ2F0ZXdheS5Kc29uU2NoZW1hO1xuICByZWFkb25seSBtb2RlbE5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgY29udGVudFR5cGU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRlc2NyaXB0aW9uPzogc3RyaW5nO1xufVxuXG4vLyBTYW1lIGFzIFJlcXVlc3RWYWxpZGF0b3JPcHRpb25zIGJ1dCByZXF1ZXN0VmFsaWRhdG9yTmFtZSBpcyByZXF1aXJlZCAodXNlZCBhcyBJRClcbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd1JlcXVlc3RWYWxpZGF0b3JPcHRpb25zIHtcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvck5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgdmFsaWRhdGVSZXF1ZXN0Qm9keT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHZhbGlkYXRlUmVxdWVzdFBhcmFtZXRlcnM/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENyb3dNZXRob2RSZXNwb25zZSB7XG4gIHJlYWRvbmx5IHN0YXR1c0NvZGU6IHN0cmluZztcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSBtb2RlbE5hbWVcbiAgcmVhZG9ubHkgcmVzcG9uc2VNb2RlbHM/OiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogc3RyaW5nIH07XG4gIHJlYWRvbmx5IHJlc3BvbnNlUGFyYW1ldGVycz86IHsgW3BhcmFtOiBzdHJpbmddOiBib29sZWFuIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb24ge1xuICAvLyBSZWRlZmluaW5nIE1ldGhvZE9wdGlvbnMgc2luY2UgT21pdCBpcyBub3Qgc3VwcG9ydGVkXG4gIHJlYWRvbmx5IGFwaUtleVJlcXVpcmVkPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNjb3Blcz86IHN0cmluZ1tdO1xuICByZWFkb25seSBhdXRob3JpemF0aW9uVHlwZT86IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGU7XG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICByZWFkb25seSBtZXRob2RSZXNwb25zZXM/OiBDcm93TWV0aG9kUmVzcG9uc2VbXTtcbiAgcmVhZG9ubHkgb3BlcmF0aW9uTmFtZT86IHN0cmluZztcbiAgLy8gVGFrZXMgYSBzdHJpbmcgd2hpY2ggaXMgbWF0Y2hlZCB3aXRoIHRoZSBtb2RlbE5hbWVcbiAgcmVhZG9ubHkgcmVxdWVzdE1vZGVscz86IHsgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBzdHJpbmcgfTtcbiAgcmVhZG9ubHkgcmVxdWVzdFBhcmFtZXRlcnM/OiB7IFtwYXJhbTogc3RyaW5nXTogYm9vbGVhbiB9O1xuICAvLyBUYWtlcyBhIHN0cmluZyB3aGljaCBpcyBtYXRjaGVkIHdpdGggdGhlIHJlcXVlc3RWYWxpZGF0b3JOYW1lXG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3I/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHJlcXVlc3RWYWxpZGF0b3JPcHRpb25zPzogYXBpZ2F0ZXdheS5SZXF1ZXN0VmFsaWRhdG9yT3B0aW9ucztcbiAgcmVhZG9ubHkgdXNlQXV0aG9yaXplckxhbWJkYT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb25zIHtcbiAgLy8gbWV0aG9kQnlQYXRoIHNob3VsZCBiZSBsYW1iZGEuTm9kZWpzRnVuY3Rpb25Qcm9wc1xuICAvLyB3aXRob3V0IGFueXRoaW5nIHJlcXVpcmVkXG4gIC8vIGJ1dCBqc2lpIGRvZXMgbm90IGFsbG93IGZvciBPbWl0IHR5cGVcbiAgW21ldGhvZEJ5UGF0aDogc3RyaW5nXTogQ3Jvd01ldGhvZENvbmZpZ3VyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3Jvd0FwaVByb3BzIHtcbiAgcmVhZG9ubHkgc291cmNlRGlyZWN0b3J5Pzogc3RyaW5nO1xuICByZWFkb25seSBzaGFyZWREaXJlY3Rvcnk/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHVzZUF1dGhvcml6ZXJMYW1iZGE/OiBib29sZWFuO1xuICByZWFkb25seSB1c2VBdXRob3JpemVyTGFtYmRhT25BbGxSb3V0ZXM/OiBib29sZWFuO1xuICByZWFkb25seSBhdXRob3JpemVyRGlyZWN0b3J5Pzogc3RyaW5nO1xuICAvLyBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJhdGlvbiBzaG91bGQgYmUgbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmF0aW9uPzpcbiAgICB8IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uUHJvcHNcbiAgICB8IGFueTtcbiAgLy8gYXV0aG9yaXplckNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGFwaWdhdGV3YXkuVG9rZW5BdXRob3JpemVyUHJvcHNcbiAgLy8gd2l0aG91dCBhbnl0aGluZyByZXF1aXJlZFxuICAvLyBidXQganNpaSBkb2VzIG5vdCBhbGxvdyBmb3IgT21pdCB0eXBlXG4gIHJlYWRvbmx5IHRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb24/OiBhcGlnYXRld2F5LlRva2VuQXV0aG9yaXplclByb3BzIHwgYW55O1xuICByZWFkb25seSBjcmVhdGVBcGlLZXk/OiBib29sZWFuO1xuICByZWFkb25seSBsb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IGNvcnNPcHRpb25zPzogQ29yc09wdGlvbnM7XG4gIC8vIGFwaUdhdHdheUNvbmZpZ3VyYXRpb24gc2hvdWxkIGJlIGFwaWdhdGV3YXkuTGFtYmRhUmVzdEFwaVByb3BzXG4gIC8vIHdpdGhvdXQgYW55dGhpbmcgcmVxdWlyZWRcbiAgLy8gYnV0IGpzaWkgZG9lcyBub3QgYWxsb3cgZm9yIE9taXQgdHlwZVxuICByZWFkb25seSBhcGlHYXRld2F5Q29uZmlndXJhdGlvbj86IGFwaWdhdGV3YXkuUmVzdEFwaVByb3BzIHwgYW55O1xuICByZWFkb25seSBhcGlHYXRld2F5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgbGFtYmRhQ29uZmlndXJhdGlvbnM/OiBDcm93TGFtYmRhQ29uZmlndXJhdGlvbnM7XG4gIHJlYWRvbmx5IGxhbWJkYUludGVncmF0aW9uT3B0aW9ucz86IHtcbiAgICBbbGFtYmRhUGF0aDogc3RyaW5nXTogYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbk9wdGlvbnM7XG4gIH07XG4gIHJlYWRvbmx5IG1vZGVscz86IENyb3dNb2RlbE9wdGlvbnNbXTtcbiAgcmVhZG9ubHkgcmVxdWVzdFZhbGlkYXRvcnM/OiBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnNbXTtcbiAgcmVhZG9ubHkgbWV0aG9kQ29uZmlndXJhdGlvbnM/OiBDcm93TWV0aG9kQ29uZmlndXJhdGlvbnM7XG59XG5cbmludGVyZmFjZSBGU0dyYXBoTm9kZSB7XG4gIHJlc291cmNlOiBhcGlnYXRld2F5LklSZXNvdXJjZTtcbiAgcGF0aDogc3RyaW5nO1xuICBwYXRoczogc3RyaW5nW107XG4gIHZlcmJzOiBzdHJpbmdbXTtcbn1cblxuaW50ZXJmYWNlIEZTR3JhcGgge1xuICBbcGF0aDogc3RyaW5nXTogRlNHcmFwaE5vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBDcm93QXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIGdhdGV3YXkhOiBhcGlnYXRld2F5LlJlc3RBcGk7XG4gIHB1YmxpYyB1c2FnZVBsYW4hOiBhcGlnYXRld2F5LlVzYWdlUGxhbjtcbiAgcHVibGljIGF1dGhvcml6ZXIhOiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICBwdWJsaWMgYXV0aG9yaXplckxhbWJkYSE6IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uO1xuICBwdWJsaWMgbGFtYmRhTGF5ZXIhOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkO1xuICBwdWJsaWMgbGFtYmRhRnVuY3Rpb25zITogTGFtYmRhc0J5UGF0aDtcbiAgcHVibGljIG1vZGVscyE6IHsgW21vZGVsTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfTtcbiAgcHVibGljIHJlcXVlc3RWYWxpZGF0b3JzIToge1xuICAgIFtyZXF1ZXN0VmFsaWRhdG9yc05hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSVJlcXVlc3RWYWxpZGF0b3I7XG4gIH07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBDcm93QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gUHVsbGluZyBvdXQgcHJvcHNcbiAgICBjb25zdCB7XG4gICAgICBzb3VyY2VEaXJlY3RvcnkgPSBcInNyY1wiLFxuICAgICAgc2hhcmVkRGlyZWN0b3J5ID0gXCJzaGFyZWRcIixcbiAgICAgIHVzZUF1dGhvcml6ZXJMYW1iZGEgPSBmYWxzZSxcbiAgICAgIHVzZUF1dGhvcml6ZXJMYW1iZGFPbkFsbFJvdXRlcyA9IGZhbHNlLFxuICAgICAgYXV0aG9yaXplckRpcmVjdG9yeSA9IFwiYXV0aG9yaXplclwiLFxuICAgICAgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIHRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIGNyZWF0ZUFwaUtleSA9IGZhbHNlLFxuICAgICAgbG9nUmV0ZW50aW9uID0gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgYXBpR2F0ZXdheUNvbmZpZ3VyYXRpb24gPSB7fSxcbiAgICAgIGFwaUdhdGV3YXlOYW1lID0gXCJjcm93LWFwaVwiLFxuICAgICAgbGFtYmRhQ29uZmlndXJhdGlvbnMgPSB7fSxcbiAgICAgIGxhbWJkYUludGVncmF0aW9uT3B0aW9ucyA9IHt9LFxuICAgICAgbW9kZWxzID0gW10sXG4gICAgICByZXF1ZXN0VmFsaWRhdG9ycyA9IFtdLFxuICAgICAgbWV0aG9kQ29uZmlndXJhdGlvbnMgPSB7fSxcbiAgICAgIGNvcnNPcHRpb25zID0gbnVsbFxuICAgIH0gPSBwcm9wcztcblxuICAgIC8vIEluaXRpYWxpemluZyBjb25zdGFudHNcbiAgICBjb25zdCBMQU1CREFfUlVOVElNRSA9IGxhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YO1xuICAgIGNvbnN0IFNQRUNJQUxfRElSRUNUT1JJRVMgPSBbc2hhcmVkRGlyZWN0b3J5LCBhdXRob3JpemVyRGlyZWN0b3J5XTtcblxuICAgIC8vIEhlbHBlcnMgZnVuY3Rpb25zIGZvciBjb25zdHJ1Y3RvclxuXG4gICAgLy8gUHJlcGFyZXMgZGVmYXVsdCBMYW1iZGEgcHJvcHMgYW5kIG92ZXJyaWRlcyB0aGVtIHdpdGggdXNlciBpbnB1dFxuICAgIGZ1bmN0aW9uIGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgY29kZVBhdGg6IHN0cmluZyxcbiAgICAgIHVzZXJDb25maWd1cmF0aW9uOiBub2RlX2xhbWJkYS5Ob2RlanNGdW5jdGlvblByb3BzLFxuICAgICAgc2hhcmVkTGF5ZXI6IGxhbWJkYS5MYXllclZlcnNpb24gfCB1bmRlZmluZWRcbiAgICApIHtcbiAgICAgIGxldCBsYXllcnM7XG4gICAgICBpZiAoc2hhcmVkTGF5ZXIpIHtcbiAgICAgICAgY29uc3QgeyBsYXllcnM6IHVzZXJMYXllcnMgPSBbXSB9ID0gdXNlckNvbmZpZ3VyYXRpb247XG4gICAgICAgIGxheWVycyA9IFtzaGFyZWRMYXllciwgLi4udXNlckxheWVyc107XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRlZmF1bHRQcm9wcyA9IHtcbiAgICAgICAgcnVudGltZTogTEFNQkRBX1JVTlRJTUUsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChjb2RlUGF0aCksXG4gICAgICAgIGVudHJ5OiBgJHtjb2RlUGF0aH0vaW5kZXguanNgLFxuICAgICAgICBoYW5kbGVyOiBcImhhbmRsZXJcIixcbiAgICAgICAgbG9nUmV0ZW50aW9uXG4gICAgICB9O1xuXG4gICAgICBjb25zdCBsYW1iZGFQcm9wcyA9IHtcbiAgICAgICAgLi4uZGVmYXVsdFByb3BzLFxuICAgICAgICAuLi51c2VyQ29uZmlndXJhdGlvbiwgLy8gTGV0IHVzZXIgY29uZmlndXJhdGlvbiBvdmVycmlkZSBhbnl0aGluZyBleGNlcHQgbGF5ZXJzXG4gICAgICAgIGxheWVyc1xuICAgICAgfTtcblxuICAgICAgcmV0dXJuIGxhbWJkYVByb3BzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldENvbmZpZyhcbiAgICAgIGNvbmZpZ3VyYXRpb25zOiBDcm93TWV0aG9kQ29uZmlndXJhdGlvbnMgfCBDcm93TGFtYmRhQ29uZmlndXJhdGlvbnMsXG4gICAgICBuZXdBcGlQYXRoOiBzdHJpbmdcbiAgICApOiBhbnkge1xuICAgICAgLy8gaWYgZGlyZWN0IG1hdGNoIHJldHVybiByaWdodCBhd2F5XG4gICAgICBpZiAoY29uZmlndXJhdGlvbnNbbmV3QXBpUGF0aF0pIHtcbiAgICAgICAgcmV0dXJuIGNvbmZpZ3VyYXRpb25zW25ld0FwaVBhdGhdO1xuICAgICAgfVxuXG4gICAgICAvLyBjaGVjayBhbGwgcm91dGUgd2lsZCBjYXJkIG9wdGlvbnMgZm9yIG1hdGNoaW5nIGNvbmZpZ3NcbiAgICAgIGxldCBiYXNlUm91dGU6IHN0cmluZyA9IFwiXCI7XG4gICAgICBjb25zdCBtYXRjaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gbmV3QXBpUGF0aFxuICAgICAgICAuc3BsaXQoXCIvXCIpXG4gICAgICAgIC5tYXAoKHNlZ21lbnQpID0+IHtcbiAgICAgICAgICBpZiAoc2VnbWVudCkge1xuICAgICAgICAgICAgYmFzZVJvdXRlICs9IGAvJHtzZWdtZW50fWA7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBgJHtiYXNlUm91dGV9LypgO1xuICAgICAgICB9KVxuICAgICAgICAuZmluZCgod2lsZGNhcmQpID0+ICEhY29uZmlndXJhdGlvbnNbd2lsZGNhcmRdKTtcblxuICAgICAgaWYgKG1hdGNoKSB7XG4gICAgICAgIHJldHVybiBjb25maWd1cmF0aW9uc1ttYXRjaF07XG4gICAgICB9XG5cbiAgICAgIC8vIHJldHVybnMgZW1wdHkgY29uZmlnXG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgLy8gUmV0dXJucyBjaGlsZCBkaXJlY3RvcmllcyBnaXZlbiB0aGUgcGF0aCBvZiBhIHBhcmVudFxuICAgIGZ1bmN0aW9uIGdldERpcmVjdG9yeUNoaWxkcmVuKHBhcmVudERpcmVjdG9yeTogc3RyaW5nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkaXJlY3RvcmllcyA9IGZzZVxuICAgICAgICAgIC5yZWFkZGlyU3luYyhwYXJlbnREaXJlY3RvcnksIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgICAgIC5maWx0ZXIoKGRpcmVudDogYW55KSA9PiBkaXJlbnQuaXNEaXJlY3RvcnkoKSlcbiAgICAgICAgICAubWFwKChkaXJlbnQ6IGFueSkgPT4gZGlyZW50Lm5hbWUpO1xuICAgICAgICByZXR1cm4gZGlyZWN0b3JpZXM7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBvbmx5IHRpbWUgSSBoYXZlIHJ1biBpbnRvIHRoaXMgd2FzIHdoZW4gdGhlIHNyYy8gZGlyZWN0b3J5XG4gICAgICAgICAqIHdhcyBlbXB0eS5cbiAgICAgICAgICogSWYgaXQgaXMgZW1wdHksIGxldCBDREsgdHJlZSB2YWxpZGF0aW9uIHRlbGwgdXNlciB0aGF0IHRoZVxuICAgICAgICAgKiBSRVNUIEFQSSBkb2VzIG5vdCBoYXZlIGFueSBtZXRob2RzLlxuICAgICAgICAgKi9cbiAgICAgIH1cbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG5cbiAgICAvLyBBUEkgR2F0ZXdheSBsb2cgZ3JvdXBcbiAgICBjb25zdCBnYXRld2F5TG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcImFwaS1hY2Nlc3MtbG9nc1wiLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFS1xuICAgIH0pO1xuXG4gICAgLy8gVGhlIEFQSSBHYXRld2F5IGl0c2VsZlxuICAgIGNvbnN0IGdhdGV3YXkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsIGFwaUdhdGV3YXlOYW1lLCB7XG4gICAgICBkZXBsb3k6IHRydWUsXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIGxvZ2dpbmdMZXZlbDogYXBpZ2F0ZXdheS5NZXRob2RMb2dnaW5nTGV2ZWwuRVJST1IsXG4gICAgICAgIGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uOiBuZXcgYXBpZ2F0ZXdheS5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKFxuICAgICAgICAgIGdhdGV3YXlMb2dHcm91cFxuICAgICAgICApXG4gICAgICB9LFxuICAgICAgYXBpS2V5U291cmNlVHlwZTogY3JlYXRlQXBpS2V5XG4gICAgICAgID8gYXBpZ2F0ZXdheS5BcGlLZXlTb3VyY2VUeXBlLkhFQURFUlxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIGRlZmF1bHRDb3JzUHJlZmxpZ2h0T3B0aW9uczogY29yc09wdGlvbnMgPyBjb3JzT3B0aW9ucyA6IHVuZGVmaW5lZCxcbiAgICAgIC4uLmFwaUdhdGV3YXlDb25maWd1cmF0aW9uXG4gICAgfSk7XG5cbiAgICBjb25zdCBjcmVhdGVkTW9kZWxzOiB7IFttb2RlbE5hbWU6IHN0cmluZ106IGFwaWdhdGV3YXkuSU1vZGVsIH0gPSB7fTtcbiAgICBtb2RlbHMuZm9yRWFjaCgobW9kZWw6IENyb3dNb2RlbE9wdGlvbnMpID0+IHtcbiAgICAgIC8vIG1vZGVsTmFtZSBpcyB1c2VkIGFzIElEIGFuZCBjYW4gbm93IGJlIHVzZWQgZm9yIHJlZmVyZW5jaW5nIG1vZGVsIGluIG1ldGhvZCBvcHRpb25zXG4gICAgICBjcmVhdGVkTW9kZWxzW21vZGVsLm1vZGVsTmFtZV0gPSBnYXRld2F5LmFkZE1vZGVsKG1vZGVsLm1vZGVsTmFtZSwgbW9kZWwpO1xuICAgIH0pO1xuICAgIGNvbnN0IGNyZWF0ZWRSZXF1ZXN0VmFsaWRhdG9yczoge1xuICAgICAgW3JlcXVlc3RWYWxpZGF0b3JzTmFtZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JUmVxdWVzdFZhbGlkYXRvcjtcbiAgICB9ID0ge307XG4gICAgcmVxdWVzdFZhbGlkYXRvcnMuZm9yRWFjaChcbiAgICAgIChyZXF1ZXN0VmFsaWRhdG9yOiBDcm93UmVxdWVzdFZhbGlkYXRvck9wdGlvbnMpID0+IHtcbiAgICAgICAgLy8gcmVxdWVzdFZhbGlkYXRvck5hbWUgaXMgdXNlZCBhcyBJRCBhbmQgY2FuIG5vdyBiZSB1c2VkIGZvciByZWZlcmVuY2luZyBtb2RlbCBpbiBtZXRob2Qgb3B0aW9uc1xuICAgICAgICBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnNbcmVxdWVzdFZhbGlkYXRvci5yZXF1ZXN0VmFsaWRhdG9yTmFtZV0gPVxuICAgICAgICAgIGdhdGV3YXkuYWRkUmVxdWVzdFZhbGlkYXRvcihcbiAgICAgICAgICAgIHJlcXVlc3RWYWxpZGF0b3IucmVxdWVzdFZhbGlkYXRvck5hbWUsXG4gICAgICAgICAgICByZXF1ZXN0VmFsaWRhdG9yXG4gICAgICAgICAgKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQ3JlYXRlIEFQSSBrZXkgaWYgZGVzaXJlZFxuICAgIGlmIChjcmVhdGVBcGlLZXkpIHtcbiAgICAgIGNvbnN0IGFwaUtleSA9IGdhdGV3YXkuYWRkQXBpS2V5KFwiYXBpLWtleVwiKTtcbiAgICAgIGNvbnN0IHVzYWdlUGxhbiA9IG5ldyBhcGlnYXRld2F5LlVzYWdlUGxhbih0aGlzLCBcInVzYWdlLXBsYW5cIiwge1xuICAgICAgICB0aHJvdHRsZToge1xuICAgICAgICAgIGJ1cnN0TGltaXQ6IDUwMDAsXG4gICAgICAgICAgcmF0ZUxpbWl0OiAxMDAwMFxuICAgICAgICB9LFxuICAgICAgICBhcGlTdGFnZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBhcGk6IGdhdGV3YXksXG4gICAgICAgICAgICBzdGFnZTogZ2F0ZXdheS5kZXBsb3ltZW50U3RhZ2VcbiAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICAgIH0pO1xuICAgICAgdXNhZ2VQbGFuLmFkZEFwaUtleShhcGlLZXkpO1xuICAgICAgdGhpcy51c2FnZVBsYW4gPSB1c2FnZVBsYW47XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBsYXllciBvdXQgb2Ygc2hhcmVkIGRpcmVjdG9yeSBpZiBpdCBleGlzdHNcbiAgICBjb25zdCBzb3VyY2VTaGFyZWREaXJlY3RvcnkgPSBgJHtzb3VyY2VEaXJlY3Rvcnl9LyR7c2hhcmVkRGlyZWN0b3J5fWA7XG4gICAgbGV0IHNoYXJlZExheWVyOiBsYW1iZGEuTGF5ZXJWZXJzaW9uIHwgdW5kZWZpbmVkO1xuICAgIGlmIChmc2UuZXhpc3RzU3luYyhzb3VyY2VTaGFyZWREaXJlY3RvcnkpKSB7XG4gICAgICBzaGFyZWRMYXllciA9IG5ldyBsYW1iZGEuTGF5ZXJWZXJzaW9uKHRoaXMsIFwic2hhcmVkLWxheWVyXCIsIHtcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHNvdXJjZVNoYXJlZERpcmVjdG9yeSksXG4gICAgICAgIGNvbXBhdGlibGVSdW50aW1lczogW0xBTUJEQV9SVU5USU1FXSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMubGFtYmRhTGF5ZXIgPSBzaGFyZWRMYXllcjtcbiAgICB9XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGF1dGhvcml6ZXIgdG8gYmUgdXNlZCBpbiBzdWJzZXF1ZW50IE1ldGhvZHNcbiAgICBsZXQgdG9rZW5BdXRob3JpemVyOiBhcGlnYXRld2F5LklBdXRob3JpemVyO1xuICAgIGlmICh1c2VBdXRob3JpemVyTGFtYmRhKSB7XG4gICAgICBjb25zdCBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSA9IGAke3NvdXJjZURpcmVjdG9yeX0vJHthdXRob3JpemVyRGlyZWN0b3J5fWA7XG5cbiAgICAgIGNvbnN0IGF1dGhvcml6ZXJMYW1iZGFQcm9wcyA9IGJ1bmRsZUxhbWJkYVByb3BzKFxuICAgICAgICBmdWxsQXV0aG9yaXplckRpcmVjdG9yeSxcbiAgICAgICAgYXV0aG9yaXplckxhbWJkYUNvbmZpZ3VyYXRpb24sXG4gICAgICAgIHNoYXJlZExheWVyXG4gICAgICApO1xuXG4gICAgICBjb25zdCBhdXRob3JpemVyTGFtYmRhID0gbmV3IG5vZGVfbGFtYmRhLk5vZGVqc0Z1bmN0aW9uKFxuICAgICAgICB0aGlzLFxuICAgICAgICBcImF1dGhvcml6ZXItbGFtYmRhXCIsXG4gICAgICAgIGF1dGhvcml6ZXJMYW1iZGFQcm9wc1xuICAgICAgKTtcbiAgICAgIHRoaXMuYXV0aG9yaXplckxhbWJkYSA9IGF1dGhvcml6ZXJMYW1iZGE7XG5cbiAgICAgIGNvbnN0IGJ1bmRsZWRUb2tlbkF1dGhDb25maWcgPSB7XG4gICAgICAgIGhhbmRsZXI6IGF1dGhvcml6ZXJMYW1iZGEsXG4gICAgICAgIHJlc3VsdHNDYWNoZVR0bDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzYwMCksXG4gICAgICAgIC4uLnRva2VuQXV0aG9yaXplckNvbmZpZ3VyYXRpb25cbiAgICAgIH07XG4gICAgICB0b2tlbkF1dGhvcml6ZXIgPSBuZXcgYXBpZ2F0ZXdheS5Ub2tlbkF1dGhvcml6ZXIoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIFwidG9rZW4tYXV0aG9yaXplclwiLFxuICAgICAgICBidW5kbGVkVG9rZW5BdXRoQ29uZmlnXG4gICAgICApO1xuICAgICAgdGhpcy5hdXRob3JpemVyID0gdG9rZW5BdXRob3JpemVyO1xuICAgIH1cblxuICAgIC8vIFRpbWUgdG8gc3RhcnQgd2Fsa2luZyB0aGUgZGlyZWN0b3JpZXNcbiAgICBjb25zdCByb290ID0gc291cmNlRGlyZWN0b3J5O1xuICAgIGNvbnN0IHZlcmJzID0gW1wiZ2V0XCIsIFwicG9zdFwiLCBcInB1dFwiLCBcImRlbGV0ZVwiXTtcbiAgICBjb25zdCBncmFwaDogRlNHcmFwaCA9IHt9O1xuICAgIGNvbnN0IGxhbWJkYXNCeVBhdGg6IExhbWJkYXNCeVBhdGggPSB7fTtcblxuICAgIC8vIEluaXRpYWxpemUgd2l0aCByb290XG4gICAgZ3JhcGhbXCIvXCJdID0ge1xuICAgICAgcmVzb3VyY2U6IGdhdGV3YXkucm9vdCxcbiAgICAgIHBhdGg6IHJvb3QsXG4gICAgICBwYXRoczogW10sXG4gICAgICB2ZXJiczogW11cbiAgICB9O1xuICAgIC8vIEZpcnN0IGVsZW1lbnQgaW4gdHVwbGUgaXMgZGlyZWN0b3J5IHBhdGgsIHNlY29uZCBpcyBBUEkgcGF0aFxuICAgIGNvbnN0IG5vZGVzOiBbc3RyaW5nLCBzdHJpbmddW10gPSBbW3Jvb3QsIFwiL1wiXV07XG5cbiAgICAvLyBCRlMgdGhhdCBjcmVhdGVzIEFQSSBHYXRld2F5IHN0cnVjdHVyZSB1c2luZyBhZGRNZXRob2RcbiAgICB3aGlsZSAobm9kZXMubGVuZ3RoKSB7XG4gICAgICAvLyBUaGUgYHx8IFsndHlwZScsICdzY3JpcHQnXWAgcGllY2UgaXMgbmVlZGVkIG9yIFRTIHRocm93cyBhIGZpdFxuICAgICAgY29uc3QgW2RpcmVjdG9yeVBhdGgsIGFwaVBhdGhdID0gbm9kZXMuc2hpZnQoKSB8fCBbXCJ0eXBlXCIsIFwic2NyaXB0XCJdO1xuICAgICAgY29uc3QgY2hpbGRyZW46IGFueVtdID0gZ2V0RGlyZWN0b3J5Q2hpbGRyZW4oZGlyZWN0b3J5UGF0aCk7XG5cbiAgICAgIC8vIEZvciBkZWJ1Z2dpbmcgcHVycG9zZXNcbiAgICAgIC8vIGNvbnNvbGUubG9nKGAke2FwaVBhdGh9J3MgY2hpbGRyZW4gYXJlOiAke2NoaWxkcmVufWApO1xuXG4gICAgICAvLyBEb24ndCBoYXZlIHRvIHdvcnJ5IGFib3V0IHByZXZpb3VzbHkgdmlzaXRlZCBub2Rlc1xuICAgICAgLy8gc2luY2UgdGhpcyBpcyBhIGZpbGUgc3RydWN0dXJlXG4gICAgICAvLyAuLi51bmxlc3MgdGhlcmUgYXJlIHN5bWxpbmtzPyBIYXZlbid0IHJ1biBpbnRvIHRoYXRcbiAgICAgIGNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB7XG4gICAgICAgIGNvbnN0IG5ld0RpcmVjdG9yeVBhdGggPSBgJHtkaXJlY3RvcnlQYXRofS8ke2NoaWxkfWA7XG4gICAgICAgIC8vIElmIHdlJ3JlIG9uIHRoZSByb290IHBhdGgsIGRvbid0IHNlcGFyYXRlIHdpdGggYSBzbGFzaCAoLylcbiAgICAgICAgLy8gICBiZWNhdXNlIGl0IGVuZHMgdXAgbG9va2luZyBsaWtlIC8vY2hpbGQtcGF0aFxuICAgICAgICBjb25zdCBuZXdBcGlQYXRoID1cbiAgICAgICAgICBhcGlQYXRoID09PSBcIi9cIiA/IGAvJHtjaGlsZH1gIDogYCR7YXBpUGF0aH0vJHtjaGlsZH1gO1xuXG4gICAgICAgIGlmICh2ZXJicy5pbmNsdWRlcyhjaGlsZCkpIHtcbiAgICAgICAgICAvLyBJZiBkaXJlY3RvcnkgaXMgYSB2ZXJiLCB3ZSBkb24ndCB0cmF2ZXJzZSBpdCBhbnltb3JlXG4gICAgICAgICAgLy8gICBhbmQgbmVlZCB0byBjcmVhdGUgYW4gQVBJIEdhdGV3YXkgbWV0aG9kIGFuZCBMYW1iZGFcbiAgICAgICAgICBjb25zdCB1c2VyTGFtYmRhQ29uZmlndXJhdGlvbjogTm9kZWpzRnVuY3Rpb25Qcm9wcyA9IGdldENvbmZpZyhcbiAgICAgICAgICAgIGxhbWJkYUNvbmZpZ3VyYXRpb25zLFxuICAgICAgICAgICAgbmV3QXBpUGF0aFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3QgbGFtYmRhUHJvcHMgPSBidW5kbGVMYW1iZGFQcm9wcyhcbiAgICAgICAgICAgIG5ld0RpcmVjdG9yeVBhdGgsXG4gICAgICAgICAgICB1c2VyTGFtYmRhQ29uZmlndXJhdGlvbixcbiAgICAgICAgICAgIHNoYXJlZExheWVyXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBuZXdMYW1iZGEgPSBuZXcgbm9kZV9sYW1iZGEuTm9kZWpzRnVuY3Rpb24oXG4gICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgbmV3RGlyZWN0b3J5UGF0aCxcbiAgICAgICAgICAgIGxhbWJkYVByb3BzXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIC8vIFB1bGwgb3V0IHVzZUF1dGhvcml6ZXJMYW1iZGEgdmFsdWUgYW5kIHRoZSB0d2Vha2VkIG1vZGVsIHZhbHVlc1xuICAgICAgICAgIGNvbnN0IHtcbiAgICAgICAgICAgIHVzZUF1dGhvcml6ZXJMYW1iZGE6IGF1dGhvcml6ZXJMYW1iZGFDb25maWd1cmVkID0gZmFsc2UsXG4gICAgICAgICAgICByZXF1ZXN0TW9kZWxzOiBjcm93UmVxdWVzdE1vZGVscyxcbiAgICAgICAgICAgIG1ldGhvZFJlc3BvbnNlczogY3Jvd01ldGhvZFJlc3BvbnNlcyxcbiAgICAgICAgICAgIHJlcXVlc3RWYWxpZGF0b3I6IHJlcXVlc3RWYWxpZGF0b3JTdHJpbmcsXG4gICAgICAgICAgICAuLi51c2VyTWV0aG9kQ29uZmlndXJhdGlvblxuICAgICAgICAgIH06IENyb3dNZXRob2RDb25maWd1cmF0aW9uID0gZ2V0Q29uZmlnKFxuICAgICAgICAgICAgbWV0aG9kQ29uZmlndXJhdGlvbnMsXG4gICAgICAgICAgICBuZXdBcGlQYXRoXG4gICAgICAgICAgKTtcbiAgICAgICAgICBsZXQgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb246IGFueSA9IHtcbiAgICAgICAgICAgIC4uLnVzZXJNZXRob2RDb25maWd1cmF0aW9uXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIC8vIE1hcCBtb2RlbHNcbiAgICAgICAgICBjb25zdCByZXF1ZXN0TW9kZWxzOiB7IFtjb250ZW50VHlwZTogc3RyaW5nXTogYXBpZ2F0ZXdheS5JTW9kZWwgfSA9XG4gICAgICAgICAgICB7fTtcbiAgICAgICAgICBpZiAoY3Jvd1JlcXVlc3RNb2RlbHMpIHtcbiAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGNyb3dSZXF1ZXN0TW9kZWxzKS5mb3JFYWNoKFxuICAgICAgICAgICAgICAoW2NvbnRlbnRUeXBlLCBtb2RlbE5hbWVdKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVxdWVzdE1vZGVsc1tjb250ZW50VHlwZV0gPSBjcmVhdGVkTW9kZWxzW21vZGVsTmFtZV07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgbWV0aG9kUmVzcG9uc2VzOiBhcGlnYXRld2F5Lk1ldGhvZFJlc3BvbnNlW10gPSBbXTtcbiAgICAgICAgICBpZiAoY3Jvd01ldGhvZFJlc3BvbnNlcyAmJiBjcm93TWV0aG9kUmVzcG9uc2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNyb3dNZXRob2RSZXNwb25zZXMuZm9yRWFjaCgoY3Jvd01ldGhvZFJlc3BvbnNlKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlTW9kZWxzOiB7XG4gICAgICAgICAgICAgICAgW2NvbnRlbnRUeXBlOiBzdHJpbmddOiBhcGlnYXRld2F5LklNb2RlbDtcbiAgICAgICAgICAgICAgfSA9IHt9O1xuICAgICAgICAgICAgICBpZiAoY3Jvd01ldGhvZFJlc3BvbnNlLnJlc3BvbnNlTW9kZWxzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY3Jvd1Jlc3BvbnNlTW9kZWxzID0gY3Jvd01ldGhvZFJlc3BvbnNlLnJlc3BvbnNlTW9kZWxzO1xuICAgICAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKGNyb3dSZXNwb25zZU1vZGVscykuZm9yRWFjaChcbiAgICAgICAgICAgICAgICAgIChbY29udGVudFR5cGUsIG1vZGVsTmFtZV0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2VNb2RlbHNbY29udGVudFR5cGVdID0gY3JlYXRlZE1vZGVsc1ttb2RlbE5hbWVdO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjb25zdCB7IHN0YXR1c0NvZGUsIHJlc3BvbnNlUGFyYW1ldGVycyB9ID0gY3Jvd01ldGhvZFJlc3BvbnNlO1xuICAgICAgICAgICAgICBtZXRob2RSZXNwb25zZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgc3RhdHVzQ29kZSxcbiAgICAgICAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnMsXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VNb2RlbHNcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBGaW5kIHJlcXVlc3QgdmFsaWRhdG9yXG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgcmVxdWVzdFZhbGlkYXRvclN0cmluZyAmJlxuICAgICAgICAgICAgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzW3JlcXVlc3RWYWxpZGF0b3JTdHJpbmddXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvbi5yZXF1ZXN0VmFsaWRhdG9yID1cbiAgICAgICAgICAgICAgY3JlYXRlZFJlcXVlc3RWYWxpZGF0b3JzW3JlcXVlc3RWYWxpZGF0b3JTdHJpbmddO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLnJlcXVlc3RNb2RlbHMgPSByZXF1ZXN0TW9kZWxzO1xuICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLm1ldGhvZFJlc3BvbnNlcyA9IG1ldGhvZFJlc3BvbnNlcztcbiAgICAgICAgICAvLyBJZiB0aGlzIG1ldGhvZCBzaG91bGQgYmUgYmVoaW5kIGFuIGF1dGhvcml6ZXIgTGFtYmRhXG4gICAgICAgICAgLy8gICBjb25zdHJ1Y3QgdGhlIG1ldGhvZENvbmZpZ3VyYXRpb24gb2JqZWN0IGFzIHN1Y2hcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBhdXRob3JpemVyTGFtYmRhQ29uZmlndXJlZCAmJlxuICAgICAgICAgICAgKHVzZUF1dGhvcml6ZXJMYW1iZGFPbkFsbFJvdXRlcyB8fCB1c2VBdXRob3JpemVyTGFtYmRhKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgYnVuZGxlZE1ldGhvZENvbmZpZ3VyYXRpb24uYXV0aG9yaXphdGlvblR5cGUgPVxuICAgICAgICAgICAgICBhcGlnYXRld2F5LkF1dGhvcml6YXRpb25UeXBlLkNVU1RPTTtcbiAgICAgICAgICAgIGJ1bmRsZWRNZXRob2RDb25maWd1cmF0aW9uLmF1dGhvcml6ZXIgPSB0b2tlbkF1dGhvcml6ZXI7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgaW50ZWdyYXRpb25PcHRpb25zID0gbGFtYmRhSW50ZWdyYXRpb25PcHRpb25zW25ld0FwaVBhdGhdIHx8IHt9O1xuICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnJlc291cmNlLmFkZE1ldGhvZChcbiAgICAgICAgICAgIGNoaWxkLnRvVXBwZXJDYXNlKCksXG4gICAgICAgICAgICBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihuZXdMYW1iZGEsIGludGVncmF0aW9uT3B0aW9ucyksXG4gICAgICAgICAgICBidW5kbGVkTWV0aG9kQ29uZmlndXJhdGlvblxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKGNvcnNPcHRpb25zKSB7XG4gICAgICAgICAgICBncmFwaFthcGlQYXRoXS5yZXNvdXJjZS5hZGRDb3JzUHJlZmxpZ2h0KGNvcnNPcHRpb25zKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZ3JhcGhbYXBpUGF0aF0udmVyYnMucHVzaChjaGlsZCk7XG4gICAgICAgICAgbGFtYmRhc0J5UGF0aFtuZXdBcGlQYXRoXSA9IG5ld0xhbWJkYTtcbiAgICAgICAgfSBlbHNlIGlmIChTUEVDSUFMX0RJUkVDVE9SSUVTLmluY2x1ZGVzKGNoaWxkKSkge1xuICAgICAgICAgIC8vIFRoZSBzcGVjaWFsIGRpcmVjdG9yaWVzIHNob3VsZCBub3QgcmVzdWx0IGluIGFuIEFQSSBwYXRoXG4gICAgICAgICAgLy8gVGhpcyBtZWFucyB0aGUgQVBJIGFsc28gY2Fubm90IGhhdmUgYSByZXNvdXJjZSB3aXRoIHRoZVxuICAgICAgICAgIC8vICAgc2FtZSBuYW1lXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gSWYgZGlyZWN0b3J5IGlzIG5vdCBhIHZlcmIsIGNyZWF0ZSBuZXcgQVBJIEdhdGV3YXkgcmVzb3VyY2VcbiAgICAgICAgICAvLyAgIGZvciB1c2UgYnkgdmVyYiBkaXJlY3RvcnkgbGF0ZXJcblxuICAgICAgICAgIGNvbnN0IG5ld1Jlc291cmNlID0gZ3JhcGhbYXBpUGF0aF0ucmVzb3VyY2UucmVzb3VyY2VGb3JQYXRoKGNoaWxkKTtcblxuICAgICAgICAgIG5vZGVzLnB1c2goW25ld0RpcmVjdG9yeVBhdGgsIG5ld0FwaVBhdGhdKTtcblxuICAgICAgICAgIC8vIEFkZCBjaGlsZCB0byBwYXJlbnQncyBwYXRoc1xuICAgICAgICAgIGdyYXBoW2FwaVBhdGhdLnBhdGhzLnB1c2goY2hpbGQpO1xuXG4gICAgICAgICAgLy8gSW5pdGlhbGl6ZSBncmFwaCBub2RlIHRvIGluY2x1ZGUgY2hpbGRcbiAgICAgICAgICBncmFwaFtuZXdBcGlQYXRoXSA9IHtcbiAgICAgICAgICAgIHJlc291cmNlOiBuZXdSZXNvdXJjZSxcbiAgICAgICAgICAgIHBhdGg6IG5ld0RpcmVjdG9yeVBhdGgsXG4gICAgICAgICAgICBwYXRoczogW10sXG4gICAgICAgICAgICB2ZXJiczogW11cbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBGb3IgZGVidWdnaW5nIHB1cnBvc2VzXG4gICAgLy8gY29uc29sZS5sb2coZ3JhcGgpO1xuXG4gICAgLy8gRXhwb3NlIEFQSSBHYXRld2F5XG4gICAgdGhpcy5nYXRld2F5ID0gZ2F0ZXdheTtcbiAgICB0aGlzLmxhbWJkYUZ1bmN0aW9ucyA9IGxhbWJkYXNCeVBhdGg7XG4gICAgdGhpcy5tb2RlbHMgPSBjcmVhdGVkTW9kZWxzO1xuICAgIHRoaXMucmVxdWVzdFZhbGlkYXRvcnMgPSBjcmVhdGVkUmVxdWVzdFZhbGlkYXRvcnM7XG4gIH1cbn1cbiJdfQ==