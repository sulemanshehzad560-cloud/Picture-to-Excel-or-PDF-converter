// The AdMob IDs in admob.config.json: an app ID ("~") and a banner unit ID ("/") of the same
// AdMob account. A mistyped ID would silently show no ads, so the build fails instead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../../admob.config.json", import.meta.url), "utf8"));

test("admob.config.json holds a matching app ID and banner unit ID", () => {
  const app = /^ca-app-pub-(\d{16})~\d{10}$/.exec(config.appId);
  const unit = /^ca-app-pub-(\d{16})\/\d{10}$/.exec(config.bannerId);
  assert.ok(app, `appId looks wrong: ${config.appId}`);
  assert.ok(unit, `bannerId looks wrong: ${config.bannerId}`);
  assert.equal(app[1], unit[1], "app ID and banner unit ID come from different AdMob accounts");
});
