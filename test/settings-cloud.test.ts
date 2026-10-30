import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_SECRET_ID, CloudTtsModal, cloudHint } from "../src/settings";
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
	const key = [...m.contentEl.querySelectorAll("input")].find((x: any) => x.getAttribute("autocomplete") === "off") as any;
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

test("Google Cloud 錯誤訊息的中文提示", () => {
	assert.match(cloudHint("HTTP 400：API key not valid. Please pass a valid API key."), /金鑰不對/);
	assert.match(cloudHint("HTTP 403：Cloud Text-to-Speech API has not been used in project 123 before or it is disabled."), /還沒開啟/);
	assert.match(cloudHint("HTTP 403：Requests to this API texttospeech.googleapis.com method ... are blocked."), /API 限制/);
	assert.equal(cloudHint("HTTP 500"), "");
});
