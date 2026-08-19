#!/usr/bin/env node

const distEntry = new URL("../dist/cli.js", import.meta.url);

try {
  await import(distEntry);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error("Built CLI not found. Run `npm run build` first.");
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
