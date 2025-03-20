#!/usr/bin/env node
import { 
  Server, 
  StdioServerTransport,
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk';
import axios from 'axios';

// GitHub token from environment variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Base tidymodels documentation URL
const TIDYMODELS_DOCS_URL = 'https://www.tidymodels.org';

class TidymodelsServer {
  private server: Server;
  private axiosInstance: any;
  private cachedRepos: any[] = [];
  private cacheExpiryMs: number = 3600000; // 1 hour
  private lastCacheUpdate: number = 0;
  private repoContentCache: Map<string, any> = new Map();
  private documentationCache: Map<string, any> = new Map();

  constructor() {
    this.server = new Server(
      {
        name: 'tidymodels-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: 'https://api.github.com',
      headers: GITHUB_TOKEN ? {
        Authorization: `token ${GITHUB_TOKEN}`
      } : {}
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // Helper methods for GitHub API
  private async getRepos(forceRefresh: boolean = false): Promise<any[]> {
    const now = Date.now();
    if (forceRefresh || this.cachedRepos.length === 0 || (now - this.lastCacheUpdate) > this.cacheExpiryMs) {
      try {
        console.error('Fetching tidymodels repositories from GitHub...');
        const response = await this.axiosInstance.get('/orgs/tidymodels/repos', {
          params: {
            per_page: 100,
            sort: 'updated'
          }
        });
        
        this.cachedRepos = response.data;
        this.lastCacheUpdate = now;
        console.error(`Cached ${this.cachedRepos.length} repositories`);
      } catch (error) {
        console.error('Error fetching repositories:', error);
        // If there's an error, use the cached data if available
        if (this.cachedRepos.length === 0) {
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to fetch repositories: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    return this.cachedRepos;
  }

  private async getRepoContent(repo: string, path: string = ''): Promise<any> {
    const cacheKey = `${repo}:${path}`;
    if (this.repoContentCache.has(cacheKey)) {
      return this.repoContentCache.get(cacheKey);
    }

    try {
      const response = await this.axiosInstance.get(`/repos/tidymodels/${repo}/contents/${path}`);
      this.repoContentCache.set(cacheKey, response.data);
      return response.data;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch content for ${repo}/${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getFileContent(repo: string, path: string): Promise<string> {
    try {
      const response = await this.axiosInstance.get(`/repos/tidymodels/${repo}/contents/${path}`);

      if ('content' in response.data && 'encoding' in response.data) {
        const fileData = response.data as { content: string; encoding: string };
        if (fileData.encoding === 'base64') {
          return Buffer.from(fileData.content, 'base64').toString('utf-8');
        }
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Invalid file data format for ${repo}/${path}`
      );
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch file content for ${repo}/${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async searchCodeInOrg(query: string): Promise<any[]> {
    try {
      const response = await this.axiosInstance.get('/search/code', {
        params: {
          q: `org:tidymodels ${query}`,
          per_page: 100
        }
      });
      return response.data.items;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getTidymodelsRReference(packageName?: string): Promise<any> {
    try {
      // First get the list of repos to find the R packages
      const repos = await this.getRepos();
      
      const rPackages = repos.filter(repo => {
        // Filter by specific package if provided
        if (packageName && !repo.name.includes(packageName)) return false;
        
        // Check if this is likely an R package by looking for common files
        return true; // For now assume all are R packages, could be refined
      });
      
      const packagesInfo = await Promise.all(rPackages.map(async (repo) => {
        try {
          // Try to get DESCRIPTION file which is standard in R packages
          const descriptionContent = await this.getFileContent(repo.name, 'DESCRIPTION').catch(() => '');
          
          // Parse basic info from DESCRIPTION
          const title = descriptionContent.match(/Title: (.*)/i)?.[1] || '';
          const version = descriptionContent.match(/Version: (.*)/i)?.[1] || '';
          const description = descriptionContent.match(/Description: (.*)/i)?.[1] || repo.description || '';
          const depends = descriptionContent.match(/Depends: (.*)/i)?.[1] || '';
          const imports = descriptionContent.match(/Imports: ([\s\S]*?)(?=\n\w|$)/i)?.[1]?.replace(/\n/g, ' ') || '';
          const suggests = descriptionContent.match(/Suggests: ([\s\S]*?)(?=\n\w|$)/i)?.[1]?.replace(/\n/g, ' ') || '';
                    
          // Get README for more info
          const readmeContent = await this.getFileContent(repo.name, 'README.md').catch(() => '');
          
          return {
            name: repo.name,
            title,
            version,
            description,
            depends,
            imports,
            suggests,
            stars: repo.stargazers_count,
            open_issues: repo.open_issues_count,
            url: repo.html_url,
            language: repo.language,
            updated_at: repo.updated_at,
            readme_excerpt: readmeContent.substring(0, 1000) + (readmeContent.length > 1000 ? '...' : '')
          };
        } catch (error) {
          // If we can't get package details, return basic repo info
          return {
            name: repo.name,
            description: repo.description,
            stars: repo.stargazers_count,
            open_issues: repo.open_issues_count,
            url: repo.html_url,
            language: repo.language,
            updated_at: repo.updated_at
          };
        }
      }));

      return packagesInfo;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get R package reference: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async searchFunctionDocumentation(query: string, packageName?: string): Promise<any> {
    try {
      // Use code search to find function definitions and documentation
      const searchQuery = packageName 
        ? `org:tidymodels repo:tidymodels/${packageName} ${query} path:.R`
        : `org:tidymodels ${query} path:.R`;
        
      const response = await this.axiosInstance.get('/search/code', {
        params: {
          q: searchQuery,
          per_page: 50
        }
      });
      
      const results = await Promise.all(response.data.items.map(async (item: any) => {
        try {
          // Get the file content to extract function documentation
          const content = await this.getFileContent(item.repository.name, item.path);
          
          // Extract roxygen documentation blocks (simplified)
          const roxygenBlocks = content.match(/#'[\s\S]*?function\s*\([^)]*\)/g) || [];
          
          // Find blocks that match our query
          const matchingBlocks = roxygenBlocks.filter(block => 
            block.toLowerCase().includes(query.toLowerCase())
          );
          
          return {
            repository: item.repository.name,
            path: item.path,
            url: item.html_url,
            documentation: matchingBlocks.length > 0 
              ? matchingBlocks.join('\n\n') 
              : 'No documentation found'
          };
        } catch (error) {
          return {
            repository: item.repository.name,
            path: item.path,
            url: item.html_url,
            error: `Failed to fetch content: ${error instanceof Error ? error.message : String(error)}`
          };
        }
      }));
      
      return results;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search function documentation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async generateRCode(request: string, templateType?: string): Promise<string> {
    // This function would generate R code based on the template type and request
    // In a real implementation, this might call an API or use embedded templates
    
    // For now, we'll return template examples based on the request type
    let codeTemplate = '';
    
    switch (templateType?.toLowerCase()) {
      case 'recipe':
        codeTemplate = `# Recipe for preprocessing data
library(tidymodels)

# Create a recipe for data preprocessing
recipe <- recipe(target ~ ., data = data) |>
  step_normalize(all_numeric_predictors()) |>
  step_dummy(all_nominal_predictors()) |>
  step_zv(all_predictors()) |>
  step_corr(all_numeric_predictors())

# Prepare the recipe on training data
recipe_prepped <- prep(recipe, training = training_data)

# Apply to data
processed_data <- bake(recipe_prepped, new_data = data)`;
        break;
        
      case 'model':
        codeTemplate = `# Build a tidymodels workflow for ${request}
library(tidymodels)

# Define model specification
model_spec <- 
  # Choose appropriate model for your task
  boost_tree() |>
  set_engine("xgboost") |>
  set_mode("classification") # or regression

# Create a workflow
workflow <- 
  workflow() |>
  add_recipe(recipe) |>
  add_model(model_spec)

# Fit model
fitted_model <- fit(workflow, data = training_data)

# Make predictions
predictions <- predict(fitted_model, new_data = test_data)`;
        break;
        
      case 'tune':
        codeTemplate = `# Hyperparameter tuning with tidymodels
library(tidymodels)

# Define model with tuning parameters
model_spec <- 
  boost_tree(
    trees = tune(),
    min_n = tune(),
    tree_depth = tune()
  ) |>
  set_engine("xgboost") |>
  set_mode("classification")

# Create workflow
workflow <- 
  workflow() |>
  add_recipe(recipe) |>
  add_model(model_spec)

# Create resamples for tuning
resamples <- vfold_cv(training_data, v = 5)

# Define tuning grid
tuning_grid <- grid_latin_hypercube(
  trees(range = c(10, 2000)),
  min_n(range = c(2, 40)),
  tree_depth(range = c(1, 15)),
  size = 20
)

# Tune model
tuning_results <- 
  workflow |>
  tune_grid(
    resamples = resamples,
    grid = tuning_grid,
    metrics = metric_set(roc_auc, accuracy)
  )

# Select best parameters
best_params <- select_best(tuning_results, metric = "roc_auc")

# Finalize workflow
final_workflow <- 
  workflow |>
  finalize_workflow(best_params)

# Fit final model
final_model <- fit(final_workflow, data = training_data)`;
        break;
        
      case 'evaluation':
        codeTemplate = `# Model evaluation with tidymodels
library(tidymodels)

# Create test/train split
set.seed(123)
data_split <- initial_split(data, prop = 0.75, strata = outcome)
train_data <- training(data_split)
test_data <- testing(data_split)

# Fit finalized model on training data
final_fit <- fit(workflow, data = train_data)

# Predict on test data
predictions <- predict(final_fit, test_data)
predictions_with_prob <- predict(final_fit, test_data, type = "prob")

# Combine predictions with actual values
results <- bind_cols(
  test_data,
  predictions,
  predictions_with_prob
)

# Evaluate performance
metrics <- metric_set(accuracy, roc_auc, sensitivity, specificity)
performance <- metrics(
  results,
  truth = outcome,
  estimate = .pred_class,
  .pred_yes
)

# Create confusion matrix
conf_mat(results, truth = outcome, estimate = .pred_class)

# Plot ROC curve
results |>
  roc_curve(truth = outcome, .pred_yes) |>
  autoplot()`;
        break;
        
      default:
        // General template if no specific type given
        codeTemplate = `# Tidymodels workflow for ${request}
library(tidymodels)

# Data preparation
data_split <- initial_split(data, prop = 0.75)
train_data <- training(data_split)
test_data <- testing(data_split)

# Create a recipe for data preprocessing
recipe <- recipe(outcome ~ ., data = train_data) |>
  step_normalize(all_numeric_predictors()) |>
  step_dummy(all_nominal_predictors())

# Define model
model_spec <- 
  # Choose appropriate model for your task
  rand_forest() |>
  set_engine("ranger") |>
  set_mode("classification") # or regression

# Create workflow
workflow <- 
  workflow() |>
  add_recipe(recipe) |>
  add_model(model_spec)

# Fit model
fitted_model <- fit(workflow, data = train_data)

# Evaluate model
predictions <- predict(fitted_model, test_data)
performance <- metrics(bind_cols(test_data, predictions),
                       truth = outcome,
                       estimate = .pred_class)`;
    }
    
    return codeTemplate;
  }

  private setupResourceHandlers() {
    // List all repositories as resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const repos = await this.getRepos();
      return {
        resources: [
          // Repository resources
          ...repos.map(repo => ({
            uri: `tidymodels://repos/${repo.name}`,
            name: repo.name,
            mimeType: 'application/json',
            description: repo.description || `Repository: ${repo.name}`,
          })),
          // Documentation resources
          {
            uri: 'tidymodels://docs/overview',
            name: 'Tidymodels Overview',
            mimeType: 'text/markdown',
            description: 'Overview of the tidymodels ecosystem',
          },
          {
            uri: 'tidymodels://docs/getting-started',
            name: 'Getting Started',
            mimeType: 'text/markdown', 
            description: 'Getting started with tidymodels',
          },
          // Code template resources
          {
            uri: 'tidymodels://templates/recipe',
            name: 'Recipe Template',
            mimeType: 'text/plain',
            description: 'Template for creating a tidymodels recipe',
          },
          {
            uri: 'tidymodels://templates/model',
            name: 'Model Template',
            mimeType: 'text/plain',
            description: 'Template for creating a tidymodels model',
          },
          {
            uri: 'tidymodels://templates/tune',
            name: 'Tuning Template',
            mimeType: 'text/plain',
            description: 'Template for hyperparameter tuning with tidymodels',
          },
          {
            uri: 'tidymodels://templates/evaluation',
            name: 'Evaluation Template',
            mimeType: 'text/plain',
            description: 'Template for evaluating models with tidymodels',
          }
        ],
      };
    });

    // Read resource handler
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const { uri } = request.params;
        
        // Match repository pattern
        const repoMatch = uri.match(/^tidymodels:\/\/repos\/([^\/]+)$/);
        if (repoMatch) {
          const repoName = repoMatch[1];
          const repos = await this.getRepos();
          const repo = repos.find(r => r.name === repoName);
          
          if (!repo) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Repository not found: ${repoName}`
            );
          }

          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(repo, null, 2),
              },
            ],
          };
        }
        
        // Match file pattern
        const fileMatch = uri.match(/^tidymodels:\/\/files\/([^\/]+)\/(.+)$/);
        if (fileMatch) {
          const [, repoName, filePath] = fileMatch;
          const content = await this.getFileContent(repoName, filePath);
          
          return {
            contents: [
              {
                uri,
                mimeType: this.getMimeType(filePath),
                text: content,
              },
            ],
          };
        }

        // Match documentation pattern
        const docsMatch = uri.match(/^tidymodels:\/\/docs\/(.+)$/);
        if (docsMatch) {
          const docName = docsMatch[1];
          
          // Get documentation content
          let content = '';
          
          if (docName === 'overview') {
            content = `# Tidymodels Ecosystem Overview

Tidymodels is a collection of packages for modeling and machine learning using tidyverse principles.

## Core Packages

- **rsample**: For data splitting and resampling
- **parsnip**: Provides a unified interface to models
- **recipes**: For preprocessing and feature engineering
- **workflows**: Combining preprocessing, modeling, and postprocessing
- **tune**: For hyperparameter tuning
- **yardstick**: For measuring model performance
- **dials**: Tools for creating and managing tuning parameters
- **broom**: For converting model objects into tidy data frames

## Extended Ecosystem

- **tidyposterior**: Bayesian analysis of model performance
- **corrr**: Correlation analysis tools
- **applicable**: Checking model applicability for new data
- **spatialsample**: Spatial resampling methods
- **poissonreg**: For Poisson and negative binomial regression
- **discrim**: Models for discriminant analysis
- **embed**: For creating embeddings and learned features

For more details, visit [the tidymodels website](https://www.tidymodels.org/).`;
          } else if (docName === 'getting-started') {
            content = `# Getting Started with Tidymodels

## Installation

\`\`\`r
# Install the complete tidymodels package
install.packages("tidymodels")

# Or install individual packages
install.packages(c("parsnip", "recipes", "rsample", "workflows"))
\`\`\`

## Basic Workflow

\`\`\`r
library(tidymodels)

# Split data
set.seed(123)
data_split <- initial_split(mtcars, prop = 0.75)
train_data <- training(data_split)
test_data <- testing(data_split)

# Create recipe for preprocessing
car_recipe <- recipe(mpg ~ ., data = train_data) |>
  step_normalize(all_predictors())

# Define model
lm_model <- linear_reg() |>
  set_engine("lm")

# Create workflow
lm_workflow <- workflow() |>
  add_recipe(car_recipe) |>
  add_model(lm_model)

# Fit model
lm_fit <- fit(lm_workflow, data = train_data)

# Make predictions
predictions <- predict(lm_fit, test_data)

# Evaluate performance
metrics(bind_cols(test_data, predictions), 
        truth = mpg,
        estimate = .pred)
\`\`\`

## Key Concepts

1. **Data Splitting** with rsample
2. **Preprocessing** with recipes
3. **Model Specification** with parsnip
4. **Workflow** to combine preprocessing and modeling
5. **Evaluation** with yardstick

For more examples and tutorials, visit [the tidymodels website](https://www.tidymodels.org/start/).`;
          } else {
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Documentation not found: ${docName}`
            );
          }
          
          return {
            contents: [
              {
                uri,
                mimeType: 'text/markdown',
                text: content,
              },
            ],
          };
        }

        // Match template pattern
        const templateMatch = uri.match(/^tidymodels:\/\/templates\/(.+)$/);
        if (templateMatch) {
          const templateName = templateMatch[1];
          const template = await this.generateRCode('Example task', templateName);
          
          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: template,
              },
            ],
          };
        }

        throw new McpError(
          ErrorCode.InvalidRequest,
          `Invalid URI format: ${uri}`
        );
      }
    );
  }

  private getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'r':
        return 'text/r-script';
      case 'rmd':
        return 'text/markdown';
      case 'md':
        return 'text/markdown';
      case 'json':
        return 'application/json';
      case 'yml':
      case 'yaml':
        return 'application/yaml';
      case 'txt':
        return 'text/plain';
      default:
        return 'text/plain';
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_tidymodels_packages',
          description: 'List all packages in the tidymodels ecosystem',
          inputSchema: {
            type: 'object',
            properties: {
              refresh: {
                type: 'boolean',
                description: 'Force a refresh of the repository cache',
              },
            },
          },
        },
        {
          name: 'get_package_details',
          description: 'Get detailed information about a specific tidymodels package',
          inputSchema: {
            type: 'object',
            properties: {
              package: {
                type: 'string',
                description: 'Package name',
              },
            },
            required: ['package'],
          },
        },
        {
          name: 'search_r_functions',
          description: 'Search for R functions in tidymodels packages',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Function name or keyword to search for',
              },
              package: {
                type: 'string',
                description: 'Limit search to a specific package (optional)',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'generate_tidymodels_code',
          description: 'Generate R code for common tidymodels tasks',
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Description of the task',
              },
              template: {
                type: 'string',
                description: 'Type of template (recipe, model, tune, evaluation)',
                enum: ['recipe', 'model', 'tune', 'evaluation'],
              },
            },
            required: ['task'],
          },
        },
        {
          name: 'search_issues',
          description: 'Search for issues in tidymodels repositories',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              repo: {
                type: 'string',
                description: 'Limit search to a specific repository (optional)',
              },
              state: {
                type: 'string',
                description: 'Issue state (open, closed, all)',
                enum: ['open', 'closed', 'all'],
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'list_tidymodels_packages': {
          const { refresh = false } = args as { refresh?: boolean };
          const repos = await this.getRepos(refresh);
          
          // Filter to likely R packages
          const rPackages = repos.filter(repo => {
            // Simple heuristic - could be improved
            const isRPackage = 
              repo.language === 'R' || 
              repo.name.startsWith('r') ||
              ['parsnip', 'recipes', 'rsample', 'tune', 'dials', 'workflows', 'yardstick'].includes(repo.name);
              
            return isRPackage;
          });
          
          const packageList = rPackages.map(repo => ({
            name: repo.name,
            description: repo.description,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            url: repo.html_url,
            updated_at: repo.updated_at,
          }));
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(packageList, null, 2),
              },
            ],
          };
        }

        case 'get_package_details': {
          const { package: packageName } = args as { package: string };
          if (!packageName) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Package name is required'
            );
          }

          try {
            // Get package details
            const packageDetails = await this.getTidymodelsRReference(packageName);
            
            if (packageDetails.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Package "${packageName}" not found in tidymodels organization`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(packageDetails[0], null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error fetching package details: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'search_r_functions': {
          const { query, package: packageName } = args as { query: string, package?: string };
          if (!query) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Search query is required'
            );
          }

          try {
            const searchResults = await this.searchFunctionDocumentation(query, packageName);
            
            if (searchResults.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No functions found matching "${query}" ${packageName ? `in package "${packageName}"` : ''}`,
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(searchResults, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error searching functions: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'generate_tidymodels_code': {
          const { task, template } = args as { task: string, template?: string };
          if (!task) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Task description is required'
            );
          }

          try {
            const code = await this.generateRCode(task, template);
            
            return {
              content: [
                {
                  type: 'text',
                  text: code,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error generating code: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'search_issues': {
          const { query, repo, state = 'open' } = args as { query: string, repo?: string, state?: string };
          if (!query) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Search query is required'
            );
          }

          try {
            // Build the search query
