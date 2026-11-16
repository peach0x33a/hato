import { runSetupWizard } from "../setup/wizard.js";
import { logError } from "../utils/logger.js";

runSetupWizard(process.argv.slice(2)).catch((err) => {
  logError("SETUP", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
