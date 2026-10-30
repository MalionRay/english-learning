import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_SECRET_ID, CloudTtsModal } from "../src/settings";
import { makeApp } from "./helpers/app";

test("Google Cloud 語音設定：金鑰直接存進 secretStorage、不用 SecretComponent", async () => {
	const { app } = makeApp();
	const secrets = new Map<string, string>();
	app.secretStorage = { setSecret: (id: string, v: string) => secrets.set(id, v), getSecret: (id: string) => secrets.get(id) ?? null, listSecrets: () => [...secrets.keys()] };
	let saved = 0;
	let done = 0;
	const plugin: any = {
		settings: { cloudTts: false, cloudKeySecretName: "", cloudVoice: "Kore", cloudMonthlyCap: 800000 },
		saveSettings: async () => void saved++,
		getCloudKey: () => (plugin.settings.cloudKeySecretName ? secrets.get(plugin.settings.cloudKeySecretName) ?? null : null),
		pronouncer: { cloudUsage: { used: async () => 1234 }, testCloud: async () => undefined },
	};
	const m: any = new CloudTtsModal(app, plugin, () => done++);
	m.open();
	const toggle = m.contentEl.querySelector("input[type=checkbox]");
	toggle.checked = true;
	toggle.onchange();
	const key = m.contentEl.querySelector("input[type=password]");
	key.value = "  AIza-test-key ";
	await key.oninput();
	assert.equal(secrets.get(CLOUD_SECRET_ID), "AIza-test-key");
	assert.equal(plugin.settings.cloudKeySecretName, CLOUD_SECRET_ID);
	assert.equal(plugin.settings.cloudTts, true);
	assert.equal(plugin.getCloudKey(), "AIza-test-key");
	const voices = m.contentEl.querySelector("select");
	assert.ok(voices.options.length >= 10);
	m.close();
	assert.equal(done, 1);
	assert.ok(saved >= 2);
});
