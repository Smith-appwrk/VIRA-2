@maxLength(20)
@minLength(4)
@description('Used to generate names for all resources in this file')
param resourceBaseName string

@secure()
param openAIKey string

param webAppSKU string

@maxLength(42)
param botDisplayName string

param serverfarmsName string = resourceBaseName
param webAppName string = resourceBaseName
param identityName string = resourceBaseName
param location string = resourceGroup().location

// Azure AI Search parameters
@description('SKU for Azure AI Search service. Options: free, basic, standard, standard2, standard3, storage_optimized_l1, storage_optimized_l2')
param searchServiceSku string = 'free'
@description('Name for Azure AI Search service (must be globally unique, lowercase, alphanumeric)')
param searchServiceName string = '${resourceBaseName}-search'
@description('Enable Azure AI Search (set to false if not needed)')
param enableSearchService bool = true

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  location: location
  name: identityName
}

// Compute resources for your Web App
resource serverfarm 'Microsoft.Web/serverfarms@2021-02-01' = {
  kind: 'app'
  location: location
  name: serverfarmsName
  sku: {
    name: webAppSKU
  }
}

// Web App that hosts your agent
resource webApp 'Microsoft.Web/sites@2021-02-01' = {
  kind: 'app'
  location: location
  name: webAppName
  properties: {
    serverFarmId: serverfarm.id
    httpsOnly: true
    siteConfig: {
      alwaysOn: true
      appSettings: [
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1' // Run Azure App Service from a package file
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20' // Set NodeJS version to 20.x for your site
        }
        {
          name: 'RUNNING_ON_AZURE'
          value: '1'
        }
        {
          name: 'CLIENT_ID'
          value: identity.properties.clientId
        }
        {
          name: 'TENANT_ID'
          value: identity.properties.tenantId
        }
        {
          name: 'BOT_TYPE' 
          value: 'UserAssignedMsi'
        }
        {
          name: 'OPENAI_API_KEY'
          value: openAIKey
        }
        {
          name: 'AZURE_SEARCH_ENDPOINT'
          value: enableSearchService ? 'https://${searchService.name}.search.windows.net' : ''
        }
        {
          name: 'AZURE_SEARCH_INDEX_NAME'
          value: 'intelligate-kb'
        }
        {
          name: 'AZURE_SEARCH_USE_MANAGED_IDENTITY'
          value: enableSearchService ? 'true' : 'false'
        }
      ]
      ftpsState: 'FtpsOnly'
    }
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
}

// Azure AI Search service
resource searchService 'Microsoft.Search/searchServices@2023-11-01' = if (enableSearchService) {
  name: searchServiceName
  location: location
  sku: {
    name: searchServiceSku
  }
  properties: {
    replicaCount: searchServiceSku == 'free' ? 1 : 1
    partitionCount: searchServiceSku == 'free' ? 1 : 1
    hostingMode: 'default'
    publicNetworkAccess: 'enabled'
  }
}

// Grant Managed Identity access to Azure AI Search
resource searchServiceRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableSearchService) {
  name: guid(searchService.id, identity.id, 'SearchServiceContributor')
  scope: searchService
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0') // Search Service Contributor
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Register your web service as a bot with the Bot Framework
module azureBotRegistration './botRegistration/azurebot.bicep' = {
  name: 'Azure-Bot-registration'
  params: {
    resourceBaseName: resourceBaseName
    identityClientId: identity.properties.clientId
    identityResourceId: identity.id
    identityTenantId: identity.properties.tenantId
    botAppDomain: webApp.properties.defaultHostName
    botDisplayName: botDisplayName
  }
}

// The output will be persisted in .env.{envName}. Visit https://aka.ms/teamsfx-actions/arm-deploy for more details.
output BOT_AZURE_APP_SERVICE_RESOURCE_ID string = webApp.id
output BOT_DOMAIN string = webApp.properties.defaultHostName
output BOT_ID string = identity.properties.clientId
output BOT_TENANT_ID string = identity.properties.tenantId
output AZURE_SEARCH_ENDPOINT string = enableSearchService ? 'https://${searchService.name}.search.windows.net' : ''
output AZURE_SEARCH_SERVICE_NAME string = enableSearchService ? searchService.name : ''
