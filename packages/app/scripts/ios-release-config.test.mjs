import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../app.config.js", import.meta.url));
const staticConfig = JSON.parse(readFileSync(`${appDir}/app.json`, "utf8"));
const eas = JSON.parse(readFileSync(`${appDir}/eas.json`, "utf8"));
const source = readFileSync(`${appDir}/app.config.js`, "utf8");
// Exercise the exact dynamic-config function with the input EAS updates.
const configure = vm.runInNewContext(source.replace("export default", "module.exports ="), {
  module: { exports: {} },
  require,
  process: { env: {} },
});
const { getNativeReleaseVersion } = require("./native-release-version.js");
const pkg = require("./package.json");

test("persisted iOS counter is used without changing Android/package versions", () => {
  for (const buildNumber of ["1", "2", "37"]) {
    const result = configure({ config: { ios: { buildNumber } } });
    assert.equal(result.ios.buildNumber, buildNumber);
    assert.equal(
      result.android.versionCode,
      getNativeReleaseVersion(pkg.version).androidVersionCode,
    );
    assert.equal(result.version, getNativeReleaseVersion(pkg.version).appVersion);
    assert.equal(result.ios.bundleIdentifier, "com.owa1da.pimobile");
  }
});

test("only device iOS builds increment the tracked local counter", () => {
  assert.equal(eas.cli.appVersionSource, "local");
  assert.equal(eas.build.production.ios.autoIncrement, "buildNumber");
  assert.equal(eas.build.production.android.autoIncrement, undefined);
  assert.equal(eas.build["ios-simulator"].ios.autoIncrement, false);
  assert.match(staticConfig.expo.ios.buildNumber, /^[1-9]\d*$/);
});

test("Expo loads the persisted counter through the real config loader", () => {
  const { getConfig } = require("expo/config");
  const { exp } = getConfig(appDir, { skipSDKVersionRequirement: true });
  assert.equal(exp.ios.buildNumber, staticConfig.expo.ios.buildNumber);
  assert.equal(exp.extra.eas.projectId, "d2696fae-ad1a-472f-9b34-8aeb34f66b20");
});
