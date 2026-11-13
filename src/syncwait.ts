// 等 Remotely Save 同步結束。它沒有公開的完成事件，這裡讀它內部的 isSyncing（非正式 API）。

export interface SyncProbe {
	isSyncing?: boolean;
}

export interface SyncWaitOptions {
	maxMs: number;
	onStatus?: (s: string) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * 觸發一次同步並等它結束。
 * - 自動同步正在跑：先等它結束（它可能沒包含剛寫入的紀錄），再觸發一次
 * - 觸發後等它開始（最多 3 秒），再等它結束
 * trigger 回傳有沒有成功觸發。
 */
export async function syncWithProbe(rs: SyncProbe, trigger: () => Promise<boolean>, o: SyncWaitOptions): Promise<"done" | "timeout" | "not-triggered"> {
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = o.now ?? Date.now;
	const started = now();
	const secs = () => Math.round((now() - started) / 1000);
	while (rs.isSyncing && now() - started < o.maxMs) {
		o.onStatus?.(`等待進行中的同步…（${secs()} 秒）`);
		await sleep(300);
	}
	if (!(await trigger())) return "not-triggered";
	// 「等它開始」要從觸發的時候算起。之前從一開始算：前面等別的同步超過 3 秒的話，
	// 這裡一秒都不等，剛觸發的同步還沒開始就被當成「已經同步完」
	const triggered = now();
	while (!rs.isSyncing && now() - triggered < 3000) await sleep(100);
	while (rs.isSyncing && now() - started < o.maxMs) {
		o.onStatus?.(`同步中…（${secs()} 秒）`);
		await sleep(300);
	}
	return rs.isSyncing ? "timeout" : "done";
}
