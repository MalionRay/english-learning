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
   1. 文章匯入與 AI 出題 ← v0.2.x；生字標記、音標與朗讀 ← v0.3.x；真人／Gemini 發音與錄音快取 ← v0.4.0
   2. 練習介面、SRS 依 log 重算、開始與結束同步流程 ← v0.5.0；分題型、中文翻譯、我不知道 ← v0.6.0
   3. 文字對話，錯誤回收進 SRS
   4. 鍵盤聽寫與 TTS 朗讀
   5. 依麥克風測試結果決定語音範圍
   6. 數學模組

## 題庫格式
- english/sources/<標題>.md：frontmatter 有 id、title、level(adult|kid)、status(new|generating|generated)、importedOn
- english/bank/<id>.md：新建不覆寫；上半部給人看，最後 `<!-- english-learning:bank -->` 後的 JSON 區塊給程式讀
- 每題有 UUID（id），答題 log 以題目 UUID 對應，不依賴題目在檔案中的位置
- 題型：vocab、reading（四選一，選項由程式洗牌）、cloze（練習時打字作答，答案是 options[answer]；其他選項只當資料）、translate（練習時由 AI 批改）
- 解釋一律繁體中文（台灣用語）
- 生字：文章中用 ==字== 標記（匯入時也可填，會自動標記）；出題時一定要考，vocab 題帶 marked: true
- 單字題附 IPA（美式）；題庫中的英文包在 <span class="el-say">，點擊即用系統語音朗讀（src/tts.ts）
- 發音順序（src/pronounce.ts）：已存錄音 → 字典真人錄音（單字，dictionaryapi.dev）→ Gemini TTS → 系統語音
- 錄音存 english/audio/<deviceId>/<hash>.mp3|wav（單一寫入者；檔名是正規化文字的 cyrb53 雜湊），任何裝置都可讀
- Gemini TTS 每日計數存 localStorage，以太平洋時間的日期為準；收到 429 當天停用；設定有每日上限
- 播放前必須在 click handler 同步呼叫 unlockAudio()（iOS 自動播放限制）
- 系統語音的選擇與語速存 localStorage（各裝置可用語音不同）

## 練習與 SRS（src/srs.ts、src/practice.ts、src/grade.ts）
- 答題 log：type "answer"，含 qid（題目 UUID）、bank、qtype、session、correct／choice 或 text／score；relearn 表示同場答錯後重答（不影響排程）
- 翻譯題離線時記 pending: true；之後由「作答的那台裝置」批改，另寫一筆 type "grade"（answerId 對應），不改原紀錄
- 排程：依時間戳（同時間依 UUID）重播；答對進下一格 LADDER [1,3,7,14,30,60,120,240] 天，生字用 MARKED_LADDER；答錯回第一格；到期提前 4 小時
- 出題：到期優先（上次答錯 > 生字 > 最久），不夠補新題；每場答錯的題目最後重出一次
- 同步：syncAndWait 讀 Remotely Save 內部的 isSyncing（非正式 API），讀不到就等 Vault 安靜 3 秒
- 題庫篩選：使用者名稱 kid 預設小孩題庫，其他人預設成人題庫；偏好存 localStorage
- 一次只練一種題型（開始畫面依題型列出到期／新題數）
- 中文翻譯：出題時產生 contextZh、promptZh、optionsZh（optionsZh 與 options 一起洗牌）；舊題庫或文章段落用 src/translate.ts 即時翻譯，結果快取在 localStorage
- 作答前按「中」→ hint: true；答對但 hint 時階梯不動、隔天再出
- 「我不知道」→ correct: false、dontKnow: true
- 回報有問題的題目：type "flag"／"unflag"（src/flags.ts），讀所有使用者的 log 依時間重播
- 修正題（src/fixes.ts）：回報時請 AI 出同類型替代題，append 到 english/fixes/<deviceId>.jsonl（type "fix"，replaces 原 qid，新 UUID）；原題被回報時用修正題取代（同一題多個修正取最新），沒有修正就不出；恢復原題後修正題不出
- 依原因處理（fixKind）：答案標錯→只改答案（AI 判斷原答案正確則自動 unflag）；兩個都對→換干擾選項；看不懂→重寫同一重點；翻譯或解釋有錯→只修中文，保留原 UUID（進度不變）；其他→依說明出替代題
- 練習畫面頂端一直顯示目前使用者（共用 iPad 避免記錯人）
- 同步：若自動同步正在跑，先等它結束再觸發一次
- 克漏字打字比對：不分大小寫、忽略空白／彎引號／句尾標點；提示（字首、中文）算 hint

## 備份（src/backup.ts）
- 每 7 天（或「立即備份」）把 logs、english/sources、english/bank、english/fixes 打包成 backup/<deviceId>/YYYY-MM-DD.json（{files: {path: content}}），保留最近 4 份
- 還原目前是手動：從 JSON 的 files 取出內容寫回原路徑

## 專案慣例
- 原始碼在 src/；`npm run build` 會先跑 tsc 再用 esbuild 輸出 main.js
- `npm run check` 掃描是否違反上面的硬性限制；每次改完都要跑
- 部署：把 main.js、manifest.json、styles.css 複製到
  `<vault>/.obsidian/plugins/english-learning/`（該資料夾有 .hotreload，Hot Reload 會自動重新載入）
- 發布（給 iPad/iPhone 的 BRAT）：同時改 manifest.json 與 versions.json 的版本號，推到 main；
  GitHub Action 會編譯、跑 check，並在該版本沒有 release 時自動發布 main.js、manifest.json、styles.css
- 除錯訊息寫進 Vault 的 debug/<deviceId>.md（iOS 沒有 DevTools）
- 觸發 Remotely Save 用 app.commands.executeCommandById('remotely-save:start-sync')，是非正式內部 API，失效時退回手動同步
