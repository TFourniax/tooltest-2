// Pre-alpha compatibility shim. The product name is DiffWitness; this module only preserves
// imports created on the experimental branch before the naming correction.
export {
  readIntegrationConfig as readDefitnessConfig,
  writeIntegrationConfig as writeDefitnessConfig,
  removeIntegrationConfig as removeDefitnessConfig,
  __integrationConfigTest as __defitnessConfigTest
} from './diffwitness-integration-config.mjs';
