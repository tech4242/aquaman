/**
 * Vitest setup file. When a coverage run asks for it, every process a test
 * starts (the CLI through tsx, the daemon, the hook) writes its own V8
 * coverage into AQUAMAN_CHILD_COVERAGE_DIR on exit. Setting the variable here
 * affects children only: Node reads it at startup, so this worker is unchanged.
 */
if (process.env.AQUAMAN_CHILD_COVERAGE_DIR) {
  process.env.NODE_V8_COVERAGE = process.env.AQUAMAN_CHILD_COVERAGE_DIR;
}
