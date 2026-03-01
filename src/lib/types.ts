// --- JSONL Entry Types ---

export interface JournalEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp: string;
	message?: {
		role: 'user' | 'assistant' | 'toolResult';
		content: any[];
		model?: string;
		usage?: { input: number; output: number; cost?: { total: number } };
		stopReason?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
	summary?: string;
	cwd?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	[key: string]: any;
}

export type AgentMessage = JournalEntry;

// --- Session Metadata ---

export interface SessionMeta {
	id: string;
	filePath: string;
	cwd: string;
	name: string | null;
	firstMessage: string;
	lastModified: Date;
	messageCount: number;
	model: string | null;
}

export interface ParsedSessionMeta extends SessionMeta {
	mtime: number;
	size: number;
	createdAt: string;
}

// --- Session Tree ---

export interface SessionTree {
	nodes: Record<string, AgentMessage>;
	children: Record<string, string[]>;
	roots: string[];
	leaves: string[];
	currentLeaf: string;
}

export interface BranchPoint {
	nodeId: string;
	message: string;
	branches: Branch[];
}

export interface Branch {
	childId: string;
	preview: string;
	messageCount: number;
	isCurrentPath: boolean;
}

// --- RPC Types ---

export interface RpcSessionState {
	model: { id: string; name: string; provider: string } | null;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
}

export interface ExtensionUIRequest {
	type: 'extension_ui_request';
	id: string;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	options?: string[];
	prefill?: string;
	timeout?: number;
	notifyType?: 'info' | 'warning' | 'error';
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: 'aboveEditor' | 'belowEditor';
	text?: string;
	[key: string]: any;
}
