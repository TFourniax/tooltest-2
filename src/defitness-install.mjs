// Pre-alpha compatibility shim. DiffWitness is the product; keep these exports only so experimental
// branch consumers upgrade without losing their existing project-local adapter configuration.
export {
  detectAdapters,
  installDiffWitnessIntegration as installDefitness,
  uninstallDiffWitnessIntegration as uninstallDefitness,
  diffWitnessIntegrationStatus as defitnessStatus,
  __integrationInstallTest as __defitnessInstallTest
} from './diffwitness-integration-install.mjs';
