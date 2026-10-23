# English Learning Plugin

## 硬性限制
- 必須能在 iOS 執行：manifest isDesktopOnly=false，禁用 Node API (fs, path, process)
- 檔案操作只用 Vault API；網路只用 requestUrl()，不用 fetch
- API key 用 app.secretStorage，不得寫入 data.json
- 裝置 ID 存 localStorage（app.saveLocalStorage），不得寫入 data.json

## 資料設計
- 答題紀錄：logs/<user>/<deviceId>.jsonl，append-only，每筆含 UUID
- SRS 狀態不落檔，啟動時從所有 log 重算
- 只在匯入來源的裝置出題，以 frontmatter status 防重複
- AI 呼叫抽成可替換介面（src/ai.ts 的 AIBackend）

## 開發順序
1. 驗證外掛（裝置 ID、append log、合計、API 呼叫、麥克風）✓ 已通過（Windows + iPad；iPhone 延後）
2. 正式功能：
   1. 文章匯入與 AI 出題 ← v0.2.x；生字標記、音標與朗讀 ← v0.3.0（TTS 從第 4 項提前）
   2. 練習介面、SRS 依 log 重算、開始與結束同步流程
   3. 文字對話，錯誤回收進 SRS
   4. 鍵盤聽寫與 TTS 朗讀
   5. 依麥克風測試結果決定語音範圍
   6. 數學模組

## 題庫格式
- english/sources/<標題>.md：frontmatter 有 id、title、level(adult|kid)、status(new|generating|generated)、importedOn
- english/bank/<id>.md：新建不覆寫；上半部給人看，最後 `<!-- english-learning:bank -->` 後的 JSON 區塊給程式讀
- 每題有 UUID（id），答題 log 以題目 UUID 對應，不依賴題目在檔案中的位置
- 題型：vocab、cloze、reading（四選一，選項由程式洗牌）、translate（練習時由 AI 批改）
- 解釋一律繁體中文（台灣用語）
- 生字：文章中用 ==字== 標記（匯入時也可填，會自動標記）；出題時一定要考，vocab 題帶 marked: true
- 單字題附 IPA（美式）；題庫中的英文包在 <span class="el-say">，點擊即用系統語音朗讀（src/tts.ts）
- 朗讀語音與語速存 localStorage（各裝置可用語音不同）

## 專案慣例
- 原始碼在 src/；`npm run build` 會先跑 tsc 再用 esbuild 輸出 main.js
- `npm run check` 掃描是否違反上面的硬性限制；每次改完都要跑
- 部署：把 main.js、manifest.json、styles.css 複製到
  `<vault>/.obsidian/plugins/english-learning/`（該資料夾有 .hotreload，Hot Reload 會自動重新載入）
- 發布（給 iPad/iPhone 的 BRAT）：同時改 manifest.json 與 versions.json 的版本號，推到 main；
  GitHub Action 會編譯、跑 check，並在該版本沒有 release 時自動發布 main.js、manifest.json、styles.css
- 除錯訊息寫進 Vault 的 debug/<deviceId>.md（iOS 沒有 DevTools）
- 觸發 Remotely Save 用 app.commands.executeCommandById('remotely-save:start-sync')，是非正式內部 API，失效時退回手動同步
