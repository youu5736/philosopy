const { spawn } = require("node:child_process");

const apiPort = process.env.API_PORT || "10099";
const publicPort = process.env.PORT || "8080";
const apiEnv = { ...process.env, PORT: apiPort };
const webEnv = {
  ...process.env,
  PORT: publicPort,
  API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
};

const children = new Set();

function start(name, command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
  });

  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (signal) {
      console.log(`[${name}] exited with signal ${signal}`);
    } else if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code || 1);
    }
  });

  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[replit] Starting API on ${apiPort}`);
start("api", process.execPath, ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], apiEnv);

console.log(`[replit] Starting web app on ${publicPort}`);
start("web", process.execPath, [".local-static-server.cjs"], webEnv);
