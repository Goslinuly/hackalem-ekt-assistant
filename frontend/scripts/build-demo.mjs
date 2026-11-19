// Static GitHub Pages build: `npm run build:demo` (output in frontend/out).
// The server-side proxy route cannot be exported statically, so it is moved aside during the build.
import { execSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";

const route = "src/app/api";
const parked = ".api-route-parked";
if (!existsSync("public/demo/data.json")) throw new Error("public/demo/data.json is missing; run scripts/export_demo_data.py");
renameSync(route, parked);
try {
  execSync("next build", {
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_DEMO_MODE: "1", NEXT_PUBLIC_BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH ?? "" },
  });
} finally {
  renameSync(parked, route);
}
