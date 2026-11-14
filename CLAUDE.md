# Language Learning Plugin（原名 English Learning）

- v0.21.0 起顯示名稱是 Language Learning；外掛 id 仍是 english-learning（改 id 會讓每台裝置要重新安裝、data.json 與 BRAT 追蹤失效），Vault 資料夾（english/…、logs/…）、localStorage 的 english-learning:* key、GitHub 專案名稱都不改

## 硬性限制
- 必須能在 iOS 執行：manifest isDesktopOnly=false，禁用 Node API (fs, path, process)
- 檔案操作只用 Vault API；網路只用 requestUrl()，不用 fetch
- API key 用 app.secretStorage，不得寫入 data.json
- 裝置 ID 存 localStorage（app.saveLocalStorage），不得寫入 data.json

## 資料設計
- 答題紀錄：logs/<user>/<deviceId>.jsonl，append-only，每筆含 UUID；只放學習紀錄（answer、grade、flag／unflag、word-add／remove、phrase-add／remove）
- 診斷紀錄（sync、tts、api、tap、mic）不放 logs：寫 debug/diag/<user>/<deviceId>.jsonl，只留最近的（v0.23.0，見「學習紀錄瘦身」）；寫到哪個檔由 logs.entryPath 依 type 決定，新增 log type 時要想清楚是哪一種（DIAG_TYPES）
- SRS 狀態不落檔，啟動時從所有 log 重算
- 只在匯入來源的裝置出題，以 frontmatter status 防重複
- AI 呼叫抽成可替換介面（src/ai.ts 的 AIBackend）
- 兩個模型：geminiModel（出題、修正題、錯誤分析、拍照辨識）與 fastModel（對話、批改、翻譯、查原形；plugin.fastBackend()，FallbackBackend 在模型不存在、當日額度用完或 Google 伺服器忙（5xx）時改用 geminiModel；GeminiBackend 遇到 5xx 先等 1 秒自動重試一次）。iPad 實測 2026-10-29：免費版延遲變化很大（3.5-flash-lite 常 20～37 秒，3.1-flash-lite 多半 1.6 秒），fastModel 預設 gemini-3.1-flash-lite（舊值 -preview 自動換掉）
- AI 錯誤用 classifyError 轉成中文（AIError.kind：daily／minute／auth／model／server／network）；每日額度用完後同一模型當天不再呼叫（太平洋時間）

## 開發順序
1. 驗證外掛（裝置 ID、append log、合計、API 呼叫、麥克風）✓ 已通過（Windows + iPad；iPhone 延後）
2. 正式功能：
   1. 文章匯入與 AI 出題 ← v0.2.x；生字標記、音標與朗讀 ← v0.3.x；真人／Gemini 發音與錄音快取 ← v0.4.0
   2. 練習介面、SRS 依 log 重算、開始與結束同步流程 ← v0.5.0；分題型、中文翻譯、我不知道 ← v0.6.0；回報與修正、備份 ← v0.7.x；生字本、點字、統計 ← v0.8.0
   4. 聽力練習：逐字聽寫 v0.9.0 → 改為聽力理解（中文解釋）v0.9.1；預先產生錄音 ← v0.10.0
   3. 文字對話，錯誤回收進 SRS ← v0.11.0
   5. 依麥克風測試結果決定語音範圍 ← 發音／口說改用外部 App（ELSA Speak）；v0.12.0 的口說跟讀已在 v0.12.1 移除，不要再加回來
   6. 數學模組 ← 使用者 2026-10-29 決定先不做

## 題庫格式
- english/sources/<標題>.md：frontmatter 有 id、title、level(adult|kid)、status(new|generating|generated)、importedOn
- english/bank/<id>.md：新建不覆寫；上半部給人看，最後 `<!-- english-learning:bank -->` 後的 JSON 區塊給程式讀
- 每題有 UUID（id），答題 log 以題目 UUID 對應，不依賴題目在檔案中的位置
- 題型：vocab、reading（四選一，選項由程式洗牌）、cloze（練習時打字作答，答案是 options[answer]；其他選項只當資料）、translate（練習時由 AI 批改）
- 解釋一律繁體中文（台灣用語）
- 生字：文章中用 ==字== 標記（匯入時也可填，會自動標記）；出題時一定要考，vocab 題帶 marked: true
- 單字題附 IPA（美式）；題庫中的英文包在 <span class="el-say">，點擊即用系統語音朗讀（src/tts.ts）
- 發音順序（src/pronounce.ts）：已存錄音 → 字典真人錄音（單字，dictionaryapi.dev）→ Google Cloud 語音（開啟時）→ Gemini TTS → 系統語音
- Google Cloud 語音（src/cloudtts.ts，Chirp 3 HD，en-US-Chirp3-HD-<聲音>，MP3）：每月前 100 萬字免費但要付費帳戶，所以金鑰必須來自「另一個」專案（Gemini 那個專案開付費就失去免費版）；金鑰在 SecretStorage（設定頁一列摘要＋「設定…」對話框 CloudTtsModal，用 app.secretStorage.setSecret("english-learning-cloud-tts") 直接存，不用 SecretComponent；也可用指令「設定 Google Cloud 語音」直接打開——v0.17.0 設定頁放第二個 SecretComponent 時 iPad 打開設定就當掉）；每次使用寫 tts log（source "cloud"、chars、month＝太平洋時間月份），CloudUsage 加總所有使用者與裝置的 log（UUID 去重、10 分鐘重讀）到 cloudMonthlyCap（預設 80 萬）就不再呼叫；403／金鑰錯誤停用 24 小時並提醒，其他錯誤暫停 1 分鐘；對話朗讀切句同時產生、依序播放；預先產生錄音開啟時也用它
- 錄音存 english/audio/<deviceId>/<hash>.mp3|wav（單一寫入者；檔名是正規化文字的 cyrb53 雜湊），任何裝置都可讀
- Gemini TTS 免費版每天只有 10 段（所有裝置共用，429 訊息寫 10 requests per day）：ttsDailyCap 預設 10（舊值 100 自動換掉）；預先產生錄音預設只用字典真人錄音（prefetchGemini 預設關）；對話朗讀在 ttsDailyCap ≤ 20 時整段一次產生、不切句；用完一天提醒一次並改系統語音
- 系統語音預設挑 Premium（高品質）> Enhanced（優化）英文語音（voiceQuality 看 voiceURI／name）；但 iOS WebKit 的 getVoices 不列出另外下載的高品質語音（2026-10-30 iPad 實測 Ava、Zoe 下載後沒出現；Apple 論壇證實），所以 iPad 只有內建語音
- Gemini TTS 每日計數存 localStorage，以太平洋時間的日期為準；429 內容提到 per day 才當天停用，其他 429（每分鐘上限）只暫停 60 秒；預先產生錄音遇到每分鐘上限或對話正在用語音（speakNatural 後 5 分鐘）會等 30 秒再試；設定有每日上限
- 播放前必須在 click handler 同步呼叫 unlockAudio()（iOS 自動播放限制）
- 系統語音的選擇與語速存 localStorage（各裝置可用語音不同）；選單（tts.voicePicker，設定頁與對話開始畫面都有）高品質排前面、選了直接用系統語音試唸
- 點字「看中文意思」用 translate.inlineMeaning：意思顯示在字的旁邊（span.el-w-zh，先「查詢中…」，再按一次收起來；找不到字的位置才用 noticeMeaning 提示框）；translateMany 有 hedge 6 秒、逾時 25 秒；對話 AI 回覆出現 1.5 秒後在背景 prefetchMeanings（回覆、修正句、怎麼說裡的字，跳過常見字與已快取的，一次呼叫），點字就立刻有中文；字典真人錄音也改成先播放再存檔

## 使用者（src/users.ts、src/userview.ts，v0.19.0）
- 每位使用者有程度 adult／kid（plugin.levelOf(name)）：決定預設題庫、對話角色（Alex／Mia）與情境、批改與錯誤分析標準、對話程度範圍；不要再用名字是不是 "kid" 判斷
- 清單在 Vault：english/users/<deviceId>.jsonl（append-only、單一寫入者），type "user-add"（name、level）／"user-remove"，依時間（同時間依 UUID）重播（replayUsers）；同步後所有裝置一致；也在備份範圍
- 舊版 settings.users 第一次啟動時寫成 ts 1970 的 user-add（seedEvents，kid＝小孩；localStorage english-learning:users-seeded 只做一次），任何真正的新增／刪除都比它晚，不會讓刪掉的人復活；settings.users 之後只當快取
- 設定頁「使用者」區：每位一列（程度、刪除…），「＋ 新增使用者…」（AddUserModal：名字只能 a-z0-9_-、不可重複、選成人／小孩，建立後切換成他）；指令「新增使用者」；主畫面（書本圖示）也有使用者選單、「＋ 新增使用者」（v0.20.2）和「刪除使用者…」（刪選單上選的那位，v0.20.3）
- 每位使用者自己的設定（v0.22.0）：同一個 jsonl 裡的 type "user-set"（key、value），重播時最後一筆為準、只套用在已存在的使用者（刪掉再建立是新的人，設定清空）；UserInfo.prefs；plugin.setUserPref 寫入並觸發同步；目前有 chatMemory（對話記憶長度）、remember（跨對話記憶的開關，沒設定＝開；plugin.remembers／setRemember）
- 刪除（DeleteUserModal 要輸入名字確認；至少留一位）：先寫 user-remove，再 deleteUserData 刪 logs/<name>/（所有裝置的檔）、debug/diag/<name>/（診斷紀錄）、english/reports/<name>/、english/memory/<name>/（對話記憶）、frontmatter user 是他的對話檔（照 Obsidian 刪除設定進垃圾桶），並改寫 backup/*/*.json 拿掉他的資料；文章、題庫、錄音共用不刪；刪除前把他這個月的 Google Cloud 語音字數轉記到另一位使用者（tts log，carriedFrom），每月上限才不會少算（v0.20.1）

## 多語言：英文、西班牙文、日文（src/lang.ts、src/kana.ts、src/langview.ts，v0.20.0）
- Lang = "en" | "es" | "ja"；西班牙文是拉丁美洲（墨西哥）用法，語音 es-US；日文給「從零開始」的學習者，語音 ja-JP（使用者 2026-10-31 決定）
- 每位使用者可以學多種語言：練習、對話、生字本、句子本、統計、主畫面都有「語言」選單（langSelect）；目前語言存 localStorage english-learning:lang {user: lang}（plugin.lang）
- 資料相容：英文的 key、qid、錄音雜湊、翻譯快取都不變；其他語言：生字 key "es:casa"／"ja:天気"（qid word:es:casa）、phraseKey／audioKey／聽力 id 的雜湊前面加 "es|"／"ja|"；新的 log（word-add、phrase-add、answer）帶 lang，沒有 lang＝英文；題庫、文章、對話檔、報告的 frontmatter／JSON 有 lang（沒有＝英文）
- 分字 tokenize：英文、西班牙文用字母（含重音字母）；日文用 Intl.Segmenter（沒有時依文字種類切）；比對 matchAnswer：西班牙文只差重音算對但提醒（accentOnly）；日文漢字、平假名、片假名、羅馬拼音（含長音寫法差異）都算對
- 出題（systemPrompt(level, lang)）：日文 vocab 有 reading（平假名）、romaji，cloze 有 answerReading、answerRomaji；解釋裡的漢字後面加讀音；pronLabel 顯示讀音（英文仍是 IPA）；題庫裡的 <span class="el-say" lang="ja">，點擊用對的語言唸
- 日文讀音：句子下面顯示平假名與羅馬拼音（readingMany，一次查多句、快取在 localStorage english-learning:ja-reading-cache；練習開始時先查前 12 題；「あ」按鈕切換）；對話回覆、修正、怎麼說由 AI 一起回 replyReading／replyRomaji、reading／romaji
- 假名題型（只有日文）：平假名、片假名各 46 個（KANA），qid "kana:あ"、qtype "kana"，看假名想讀音 → 翻面（羅馬拼音、例字、發音）→ 記得／不記得
- 對話角色：西班牙文 Sofía（31 歲、墨西哥市）／小孩 Diego（12 歲、瓜達拉哈拉）；日文 結衣 Yui（30 歲、東京）／小孩 陽翔 Haruto（12 歲、橫濱）；日文可以打羅馬拼音、不因羅馬拼音糾正；程度起點：日文 1、西班牙文 2；STYLE_ES／STYLE_JA
- 語音：字典真人錄音只有英文；Google Cloud 用 es-US／ja-JP 的 Chirp 3 HD（聲音沒有這個語言時改 Kore 再試）；系統語音每種語言各自選（english-learning:tts-voice:<lang>）；外掛畫面裡的 .el-say 用目前語言唸
- 翻譯、批改、聽力批改、錯誤分析、修正題、拍照辨識、查原形（aiLemma：西班牙文、日文加入生字時都查一次）都依語言換提示
- 統計依語言篩選作答（answerLang：紀錄的 lang → 題庫的 lang → 英文）
- 生字本／句子本的「移除」（word-remove／phrase-remove）也要帶 lang，否則只對英文生效；生字本顯示的字不帶 "es:"／"ja:" 前綴；日文讀音分批查（READING_BATCH：每批最多 8 句、600 字），寫回快取前重讀以免互相蓋掉；日文標記生字只在還沒標記的部分找（v0.20.1）

## 練習與 SRS（src/srs.ts、src/practice.ts、src/grade.ts）
- 答題 log：type "answer"，含 qid（題目 UUID）、bank、qtype、session、correct／choice 或 text／score；relearn 表示同場答錯後重答（不影響排程）
- 翻譯題離線時記 pending: true；之後由「作答的那台裝置」批改，另寫一筆 type "grade"（answerId 對應），不改原紀錄
- 排程：依時間戳（同時間依 UUID）重播；答對進下一格 LADDER [1,3,7,14,30,60,120,240] 天，生字用 MARKED_LADDER；答錯回第一格；到期提前 4 小時
- 出題：到期優先（上次答錯 > 生字 > 最久），不夠補新題；每場答錯的題目最後重出一次
- 每天新題上限（設定 newPerDay，預設 10，每種題型各自計算）：今天第一次練的題數由 log 算（newIntroducedToday），到期複習不受限
- 同步：syncAndWait 讀 Remotely Save 內部的 isSyncing（非正式 API；等待的邏輯在 src/syncwait.ts），讀不到就等 Vault 安靜 3 秒
- 題庫篩選：小孩使用者預設小孩題庫，成人預設成人題庫（plugin.levelOf）；偏好存 localStorage
- 一次練一種題型（開始畫面依題型列出到期／新題數）；或按最上面的「今日複習」（v0.18.0，mixSession）：各題型到期的輪流混在一起，到期不夠題數再輪流補新題（各題型仍受每日新題上限）
- 中文翻譯：出題時產生 contextZh、promptZh、optionsZh（optionsZh 與 options 一起洗牌）；舊題庫或文章段落用 src/translate.ts 即時翻譯，結果快取在 localStorage
- 作答前按「中」→ hint: true；答對但 hint 時階梯不動、隔天再出
- 「我不知道」→ correct: false、dontKnow: true
- 回報有問題的題目：type "flag"／"unflag"（src/flags.ts），讀所有使用者的 log 依時間重播
- 修正題（src/fixes.ts）：回報時請 AI 出同類型替代題，append 到 english/fixes/<deviceId>.jsonl（type "fix"，replaces 原 qid，新 UUID）；原題被回報時用修正題取代（同一題多個修正取最新），沒有修正就不出；恢復原題後修正題不出
- 依原因處理（fixKind）：答案標錯→只改答案（AI 判斷原答案正確則自動 unflag）；兩個都對→換干擾選項；看不懂→重寫同一重點；翻譯或解釋有錯→只修中文，保留原 UUID（進度不變）；其他→依說明出替代題
- 練習畫面頂端一直顯示這場練習的使用者（共用 iPad 避免記錯人；v0.22.1 起是開始練習時的那個人，不是目前選的）
- 同步：若自動同步正在跑，先等它結束再觸發一次
- 克漏字打字比對：不分大小寫、忽略空白／彎引號／句尾標點；提示（字首、中文）算 hint

## 生字本與統計（src/words.ts、src/wordviews.ts）
- 生字本每位使用者一本，不另存檔：從題庫的標記生字、vocab/cloze 答錯紀錄、log 的 "word-add"／"word-remove" 推導
- 生字複習用 SRS，qid 為 "word:<key>"、qtype "word"、bank "words"
- 練習畫面的英文句子逐字可點（Menu：唸、看中文、加入生字本）；作答前看中文算 hint
- 統計：連續天數、今日題數、30 天長條圖、各題型正確率（30 天）、已熟練（step ≥ 3）
- 字形合併（src/lemma.ts）：go／went／going 合成一筆（WordItem.forms）。順序：word-add 的 lemma（加入時字看起來像變化形才請 AI 查）→ 不規則表 IRREGULAR（有歧義的字如 left、found 只在原形也在生字本時合併）→ 字尾規則（-s、-ed、-ing…）只在原形已在生字本時合併；片語不合併
- 合併後舊 key 的複習紀錄用 aliasWordQids 在計算時改成合併後的 qid（不改 log）
- 熟練後不自動移除（間隔拉到 240 天自然淡出；手動「移除」）。生字本／句子本每張卡片標狀態（bookStatus：還沒複習／要加強＝上次答錯／學習中／熟練 ✓＝step ≥ 3），依「要加強 → 學習中 → 還沒複習」排列，熟練的收在 details「已熟練」（搜尋時自動展開）；v0.18.1

## 聽力理解（src/dictation.ts、src/grade.ts 的 gradeListening）
- v0.9.1 起取代逐字聽寫：聽句子，用中文寫出意思由 AI 批改（≥ 70 分算懂；離線 pending，之後由同一裝置補批），或翻面自己判斷（聽懂／部分懂＝hint／沒聽懂）
- 句子從題庫推導：vocab context、cloze 完整句、translate reference；小孩 3～14 字、成人 4～25 字；qid "listen:<cyrb53>"、qtype "listening"
- 播放走發音流程，慢速 0.7 倍；從「下一題」進來時自動播放（仍在點擊事件內）；diffWords 逐字比對保留備用

## 英文對話與句子本（src/chat.ts、src/chatview.ts）
- 對話記憶長度（v0.22.0，使用者 2026-11-09 要求、每個帳號各自設定）：historyTurns 只送最近 N 則訊息給 AI（N＝plugin.chatMemoryOf(user)：24／50／100／0＝整段對話，預設 50，不在選項裡的值用 50；原本固定 24）；設定頁「使用者」區下面「對話記憶長度」每位一個選單；這是「同一次對話」裡 AI 看得到多少；不同次對話之間靠「跨對話記憶」接上（v0.23.0，見下面一節），前 3 次對話另外拿來估程度
- AIBackend.chat 多輪；回覆一律 JSON：correction（原句、修正、繁中說明、想表達的意思 zh）、howto[]（中文→英文說法）、reply、replyZh
- 對話角色：成人 Alex（32 歲、Portland、設計師、去過台灣）、小孩 Mia（12 歲、Seattle）；提示要求針對細節回應、分享自己的經驗、不要制式稱讚開頭、口語、每次最多一個問題；temperature 0.9（使用者回饋 3.1-flash-lite 的回答很機械）
- 對話自適應程度（src/chatlevel.ts，v0.18.0）：每次呼叫依最近 10 則學習者訊息（含這位使用者前 3 次對話）估 1～5 級（小孩最多 4；沒紀錄時成人 3、小孩 2；樣本少時往起點靠、越新越重）。訊息分數：全中文 0.15、被糾正依字的編輯距離（小錯 0.75、重寫 0.1）、夾中文最多 0.5、沒錯 1（1～2 字 0.6）；平均少於 4 字最多 3 級；還沒有 AI 回覆的訊息不算。levelPrompt 加在系統提示：低級短句常用字，高級像朋友聊天；明確要求「自然不等於困難」，不刻意用難字難句。頂端顯示「程度：…」，改變時寫 debug
- 學習者可用英文、中文或中英夾雜；中文問「怎麼說」→ howto；英文裡夾中文 → correction＋howto
- 對話檔 conversations/<本地日期>-<deviceId>-<序號>.md：開始的裝置獨佔寫入（append）；每則訊息前有 <!--el-msg {...} --> 供續聊重建歷史；別台裝置只能查看、要開新對話
- 句子本每位使用者一本：log "phrase-add"／"phrase-remove"（key＝英文正規化後的 cyrb53），加上自動推導的「答錯的句子」：克漏字（含我不知道，整句＝填入答案）、翻譯題（reference／prompt；含 grade 判錯）、聽力（沒聽懂）；relearn 不算；移除後又答錯會再出現（failedSentenceMap＋buildPhraseBook）；舊題庫沒有中文時練習當下即時翻譯
- 對話中的 SRS 複習（src/chattargets.ts）：開始或續聊時挑到期的生字 5 個、句子 2 句（上次答錯優先；到期不夠才補少量沒複習過的），加進系統提示請 AI 自然使用並製造機會；AI 回 learnerUsed；單字要訊息裡真的出現（含變化形）才算，沒被糾正時就算 AI 沒報也算；用對了記 answer（qid word:/phrase:、correct true、via "chat"、session＝對話檔路徑），每次對話每個目標只記一次；開始畫面可關閉
- 語音輸入（src/recorder.ts 的 WavRecorder：Web Audio → 16 kHz 單聲道 WAV，最長 60 秒）：🎤 開始、「說完了」送出；錄音直接當 inlineData 送進同一次 chat 呼叫（VOICE_TURN），AI 先把逐字內容寫在 "heard"（保留文法錯誤、中文用繁體）再照常回覆；heard 空的就不存訊息；對話檔的語音訊息標 voice: true／**You 🎤:**。這是對話輸入，不是 v0.12 的口說跟讀評分
- AI 回覆自動朗讀：每台裝置設定（localStorage english-learning:chat-voice）natural＝Gemini 自然語音（預設；Pronouncer.speakNatural：切成第一句與其他、同時產生、依序播放、不存檔；拿不到就改系統語音）／system＝系統語音／off；點擊「開始對話」「送出」「說完了」時同步呼叫 primeAudio（unlockAudio＋primeSpeech）解鎖 iOS 播放
- AI 速度測試（src/speedtest.ts；對話開始畫面與指令）：在裝置上量列出模型（純網路）、最短生成、對話大小 JSON（兩次）、thinkingLevel minimal 兩種寫法、其他 flash 模型、自然語音（網路與解碼分開）與主執行緒卡頓，結果寫進 debug 並同步
- 回應速度：chat 用 hedged 請求（8 秒沒回就再送一次，取先回來的；語音 12 秒），45 秒逾時；api log 記 ms，超過 8 秒寫 debug；使用者訊息寫檔不等待（寫入佇列保持順序）
- 練習題型「句子」qid "phrase:<key>"、qtype "phrase"：看中文說英文，AI 批改（gradeTranslation）或自己判斷（會／差一點＝hint／不會）

## 跨對話記憶（src/memory.ts，v0.23.0）
- 使用者 2026-11-14 決定要做，而且「各記各的」：每位使用者、每種語言各一份（英文的 Alex、西班牙文的 Sofía、日文的結衣互相不知道）；ray 和 kid 也不混
- 做法：對話結束時請 AI（plugin.fastBackend()，temperature 0.2）把這次聊到的重點整理成幾條記憶（繁體中文、一句話、最多 60 字），下次開新對話或續聊時加進系統提示（memoryPrompt，放在 chatSystemPrompt 後面、levelPrompt 前面；對話開始時讀一次，聊到一半不換），要求自然提起、不要列出來、日期過了的計畫改問「結果怎麼樣」、和學習者現在說的不一樣時以現在為準、照樣說外語
- 存放：english/memory/<user>/<deviceId>.jsonl（append-only、每台裝置只寫自己的檔），type "mem"：lang（沒有＝英文）、add [{key, text, at}]、remove [key]、conv＋count（AI 整理了哪個對話檔、到第幾則訊息）、since、by "ai"／"user"
- 重播 replayMemory：結果＝所有加過的減掉所有刪過的（key 不重複使用，改寫＝刪舊的加新的），和紀錄的先後、各裝置時鐘無關——刪掉的不會因為同步順序又跑回來；一模一樣的句子只留新的；done＝每個對話整理到第幾則（取最大）；最新的排前面
- AI 回的是「修改」不是整份清單：{"add": [...], "update": [{id, text}], "remove": [id]}，沒提到的不動（小模型漏列時不會把記憶清掉）；現有記憶在請求裡編號 m1、m2…；parseMemoryOps 格式不對回 null（當作沒整理成功）；applyOps 一次最多加 4 條、超過 MEMORY_MAX（20）從最舊的開始丟
- 整理的時機：按「結束對話」（ChatView.end → memory.remember，背景做；等它做完再觸發同步，最多等 15 秒）；沒按就離開的在「對話開始畫面出現時」補整理（catchUp：這位使用者＋這個語言、最近 14 天、一次最多 2 個、10 分鐘內不重複看；別台裝置開始的對話要最後一句超過 30 分鐘才幫忙整理）；學習者在還沒整理的部分至少說了 2 句才整理；續聊後只把新的部分交給 AI
- MemoryManager 一次只整理一個對話（後面的要看到前面的結果）；開新對話時前一個還在整理就先等（最多 8 秒）；額度、網路、伺服器的錯不算失敗，AI 回的內容不能用才算（localStorage english-learning:memory-fail），同一個對話失敗 2 次補整理就不再試
- 角色扮演（餐廳、面試）裡說的不當成事實；不記密碼、證號、帳號、電話、地址；只記學習者自己說的，不記 AI 角色自己的故事
- 畫面：對話開始畫面有開關「讓 Alex 記得以前聊過的事」和 details「🧠 Alex 記得的事（N）」（每條可以 ✕ 刪掉、「全部忘記」要按兩次、整理中會顯示）；設定 →「使用者」下面「記得以前的對話」每位一個開關
- 關掉（user-set remember=false）：不整理、對話也不帶記憶，已經記的留著（看得到、可以刪）；重新打開時寫一筆 since，關掉期間開始的對話不補整理
- 對話開始畫面選的情境、文章、複習開關一改就存（這個畫面會因為同步、整理記憶重畫，之前要按「開始對話」才存，重畫會跳回去）
- 也在備份範圍；刪除使用者時一起刪

## 學習紀錄瘦身（src/logs.ts，v0.23.0）
- 原因：學習紀錄每次練習都要整個讀一遍，而 iPad 實際的檔案裡約 8 成是診斷紀錄（每次同步、每次發音、每次 AI 呼叫各一筆）
- 診斷紀錄寫 debug/diag/<user>/<deviceId>.jsonl（和 logs 同樣的排法，刪除使用者、轉記 Google Cloud 語音用量照舊）；不在備份範圍
- 自動清理 trimDiag：一般診斷紀錄留 14 天、最多 2000 筆；Google Cloud 語音的用量（tts、source "cloud"）留 62 天，因為每月上限要加總整個月——超過 14 天的只留算用量的欄位，id 不變
- 讀的地方兩邊都讀、UUID 去重：readCloudUsage（每月用量）、computeTotals（驗證面板的「記一筆」和最新狀態）；還沒更新的裝置繼續寫在 logs 也算得到
- 舊資料 slimLogs（啟動 90 秒後，和 trimDebug 一起）：這台裝置自己的 logs/*/<deviceId>.jsonl 裡的診斷紀錄先寫進診斷檔（已經有的不重複）、再從學習紀錄拿掉；只動自己寫的檔，別台裝置的等它們自己更新；AppendOnlyWriter.rewrite(path, fn, create) 和 append 排同一個佇列，整理時新寫入的不會掉
- 驗證面板的「記一筆」現在是診斷紀錄，14 天後合計會歸零（面板上有寫）

## 錯誤模式分析（src/patterns.ts、src/patternview.ts）
- 收集最近 60 天的錯誤：翻譯／句子題分數 < 90 且有修正、克漏字打錯（不含「我不知道」）、這位使用者對話裡的 correction；同一句只留一次，最新的最多 80 筆；少於 5 筆不呼叫 AI
- AI 回 JSON：summary、patterns[]（title、explanation、examples、tip、drills[3]）；報告存 english/reports/<user>/<日期-時分>-<deviceId>.md（單一寫入者），也在備份範圍
- 練習句勾選後加入句子本（phrase-add，source "pattern"）；入口：學習統計畫面、指令「分析常見錯誤」

## 拍照匯入（src/ocr.ts）
- 匯入視窗「拍照／選照片」：input type=file accept=image/*（可多選）；canvas 縮到長邊 1600px 的 JPEG，以 inlineData 送 Gemini（AIOptions.images）
- 回 JSON：title、text（原文照抄、合併斷行）、marked（手寫螢光筆／底線／圈起來的字 → 填進「我不會的字」）；多張依序接起來
- 照片不存進 Vault；辨識結果填進視窗讓使用者檢查後再匯入

## 錄音快取（src/audiocache.ts）
- 預先產生：每題的單字（含克漏字答案）與句子（原句、完整句、參考譯文）；出題完成後背景跑，啟動 2 分鐘後補齊「自己匯入的題庫」（bank.device），額度用完就停；設定可關閉或手動補齊全部
- normalizeSpeech 會去掉句首／句尾的 ...，同一句只存一份
- 錄音是可重建的快取：清除時可刪任何裝置資料夾的檔案（已熟練＝用到它的題目凡有人練過都 step ≥ 3；不再使用＝不屬於任何題庫也不是手動生字）
- 設定顯示錄音總用量與這台裝置的用量

## 備份（src/backup.ts）
- 每 7 天（或「立即備份」）把 logs、english/sources、english/bank、english/fixes、conversations、english/reports、english/users、english/memory（BACKUP_ROOTS；不含診斷紀錄 debug/diag）打包成 backup/<deviceId>/YYYY-MM-DD.json（{files: {path: content}}），保留最近 4 份
- 還原（設定 →「從備份還原」，restoreBackup）：只補不蓋——缺少的檔案重建；.jsonl 依每行的 id 補回缺少的行；已存在的 .md 保留不動

## v0.22.1 檢查後修正（2026-11-13，整份程式逐檔檢查；之後改這些地方要守住）
- 誰的紀錄：練習（PracticeView.user）和對話（ChatView.cuser()＝對話檔的 user）在開始時記住使用者；作答、補批改、回報、複習到的字、加入句子本／生字本都用 `makeEntry(type, extra, user)`／`addPhrase(p, user)`／`addWord(…, lang, user)` 記在那個人身上。之前用「目前選的使用者」，練到一半在別的分頁換人就會記到別人的紀錄（補批改寫到別人檔案的話，那題永遠是 pending）
- 同步等待（src/syncwait.ts 的 syncWithProbe）：「等它開始」的 3 秒要從觸發的時候算；之前從函式開始算，前面等自動同步超過 3 秒時，剛觸發的同步還沒開始就回報「已同步」
- AI 呼叫 hedged：第一次很快失敗後馬上再送，只取消「再送一次」的計時器，整體逾時要留著（之前一起清掉，第二次卡住就永遠等下去）
- 對話歷史 historyTurns：空白的訊息不送；視窗從學習者的訊息開始時不補開場指令（之前會黏在那則訊息前面）；從 AI 的訊息開始或沒有訊息才補
- AI 回覆是空的（被截斷、被擋）：當作沒有回應、不存進對話（空白的 model 訊息留在歷史裡之後每次都可能被拒絕）；不完整的 JSON 用 salvageField 救出 reply／replyZh，不顯示大括號；日文對話 maxOutputTokens 2048（還有讀音、羅馬拼音）
- 對話請求編號 reqSeq：等 AI 時結束對話或又開新的，回來的回覆只存回原本的對話檔，不畫到現在的畫面、不進新對話的歷史；sending 只由最新的請求改
- 開新對話：starting 防連點；檔名同時看索引和磁碟；失敗用 Notice 提示。frontmatter 的 user 用 yamlName（像數字、true 的名字加引號），讀的時候一律 String()
- Enter 送出：輸入法選字時不送（chatview.composing：isComposing 或 keyCode 229，Safari 選字的 Enter 沒有 isComposing）；克漏字輸入框也一樣（日文）
- 練習：「下一題」按的時候才判斷是不是最後一題，drawQuestion 沒有題目就 finish（答錯後回報最後一題會壞掉）；假名卡片不放「回報」；start() 讀檔失敗回到開始畫面；補批改同一時間只跑一個（gradingPending）
- 發音「最後點的才播」（pronounce.ts 的 wanted）：每次 pronounce／speakNatural 記下最後要聽的那一段，stopAudio 設成 null；語音從網路回來時如果已經不是最後要聽的就不播（錄音照樣存），也不改用系統語音補唸。字典錄音「拿到了但播不出來」不算字典掛掉（之前會停用字典一小時）
- 錄音 WavRecorder.start 失敗（沒給麥克風權限）要關掉 AudioContext（iOS 同時只能開幾個）
- 克漏字填答案一律用 generate.fillBlank（答案有 $ 時字串替換會出錯）；出題時「____ ____」併成一個空格，真的兩個空格的題目丟掉
- 日文克漏字「答案標錯」的修正題：answerReading／answerRomaji 換成新答案的，AI 沒給就拿掉
- 翻譯快取 translateMany 寫回前重新讀（同時進行的翻譯不互相蓋掉）；wordsToPrefetch 只讀一次快取
- 主畫面只在 english/sources、bank、fixes 變動時重畫，300 毫秒內合併成一次（homeRelevant、renderSoon；之前每個錄音檔都整頁重畫）；生字本／句子本／統計／驗證面板畫到一半又被要求重畫時，畫完再畫一次（again）
- 除錯紀錄 debug/<deviceId>.md 超過 30 萬字時只留最後 15 萬字（logs.trimDebugLog；啟動 90 秒後由 writer.rewrite 整理，排在同一個寫入佇列）
- 設定頁「上次沒畫完」的判斷用 constants.settingsStepDone（cloud-modal:done 也算畫完）；數字欄位清空時不存成 0
- 還原備份只寫回 BACKUP_ROOTS 底下；預先產生錄音的「新增」把 cloud 也算進去；同一時間的紀錄用 id 排序（生字本、句子本）

## 手機版面
- iPhone 浮動導覽列（v0.21.2）：Obsidian 手機版下方的 .mobile-navbar 會蓋住外掛畫面底部（使用者回報對話的麥克風、送出被遮住）；src/navbar.ts 只在 Platform.isPhone 量導覽列高度＋CSS bottom＋8px，存成 body 的 --el-navbar-gap（resize、visualViewport、layout-change、每 2 秒；值沒變不動），styles.css 讓所有 english-learning-* 畫面的 .view-content 底部留這麼多；iPad、電腦是 0

## 專案慣例
- 原始碼在 src/；`npm run build` 會先跑 tsc 再用 esbuild 輸出 main.js
- `npm run check` 掃描是否違反上面的硬性限制；每次改完都要跑
- `npm test`：test/*.test.ts 用 esbuild 打包（obsidian 換成 test/mocks/obsidian.cjs，DOM 用 jsdom）後由 node --test 執行；每次改完都要跑，新功能要加測試
- 實機測試狀態記在 TESTING.md：v0.6 起的功能都還沒在 iPad 實機測過（使用者決定功能做完再一起測）；新功能完成要加進「未實機測試」
- 測試資料只能用自己編的句子，不放真實文章內容（repo 是公開的）
- GitHub Action 每次推送都跑 build、check、test；推到 main 且測試通過才發布
- 部署：把 main.js、manifest.json、styles.css 複製到
  `<vault>/.obsidian/plugins/english-learning/`（該資料夾有 .hotreload，Hot Reload 會自動重新載入）
- 發布（給 iPad/iPhone 的 BRAT）：同時改 manifest.json 與 versions.json 的版本號，推到 main；
  GitHub Action 會編譯、跑 check 與測試，並在該版本沒有 release 時自動發布 main.js、manifest.json、styles.css
- 除錯訊息寫進 Vault 的 debug/<deviceId>.md（iOS 沒有 DevTools；同一個資料夾底下的 debug/diag/ 是診斷紀錄）；設定頁每畫一段就把段落名稱寫進 localStorage（english-learning:settings-step，同步寫入、當掉也留得住），下次啟動時沒畫完就記進 debug 並同步；CloudTtsModal 也記（cloud-modal:<步驟>），本月用量改成按鈕才讀；v0.17.2 在 iPad 打開這個視窗仍會當掉，v0.17.3（不自動讀用量、金鑰欄不用 type=password）就不當了；貼上的金鑰只留 [A-Za-z0-9_-] 並檢查 AIza＋39 字元；試聽錯誤用 cloudHint 給中文提示並寫 debug
- 觸發 Remotely Save 用 app.commands.executeCommandById('remotely-save:start-sync')，是非正式內部 API，失效時退回手動同步
