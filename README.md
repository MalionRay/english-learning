# English Learning — 驗證外掛 v0.1.0

只做五件事：
1. 首次啟動產生裝置 ID（例如 `win-1a2b3c4d`），存本機 localStorage。
2. 「記一筆」：往 `logs/<user>/<deviceId>.jsonl` append 一行（含 UUID、時間戳）。
3. 「合計」：讀取磁碟上所有 log，用 UUID 去重後計算；列出不符命名規則的檔案（衝突副本）。
4. 「測試 API」：用 requestUrl() 呼叫 Gemini，金鑰取自 SecretStorage；usage 寫進 log。
5. 「測試麥克風」：getUserMedia({ audio: true })，結果寫進 log。

另外有「立即同步」按鈕（觸發 Remotely Save），以及每台裝置的除錯紀錄 `debug/<deviceId>.md`。

開啟方式：左側功能列的燒瓶圖示，或指令面板搜尋「English Learning」。

## 三裝置測試清單
- [ ] 輪流在三台按「記一筆」並同步，合計正確
- [ ] 飛航模式下按幾次再恢復連線，合計正確
- [ ] 兩台同時離線各按幾次，合計正確、無衝突副本
- [ ] 一台刪除檔案，其他台不會把它復活
- [ ] 記錄同步完成需要多久
- [ ] SecretStorage 在 iOS 上確實不隨 Vault 同步
- [ ] 麥克風測試結果（決定語音功能範圍）

## 開發
需要 Node.js：`npm install`、`npm run build`、`npm run check`。
