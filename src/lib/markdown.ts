import { Marked, Renderer } from 'marked';

/**
 * Custom marked renderer for chat bubble markdown.
 * - Opens links in new tabs
 * - Adds copy buttons to code blocks (handled via CSS/JS in the component)
 * - Keeps rendering safe and minimal
 */
class ChatRenderer extends Renderer {
	// Open links in new tab
	link({ href, title, tokens }: { href: string; title?: string | null; tokens: any[] }): string {
		const text = this.parser.parseInline(tokens);
		const titleAttr = title ? ` title="${title}"` : '';
		return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
	}

	// Code blocks with language label and copy button
	code({ text, lang }: { text: string; lang?: string }): string {
		const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
		const copyBtn = `<button class="code-copy-btn" aria-label="Copy code" onclick="this.parentElement.querySelector('.code-copy-btn')?.classList.add('copied');navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy';this.parentElement.querySelector('.code-copy-btn')?.classList.remove('copied')},1500)})">Copy</button>`;
		const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
		return `<div class="code-block-wrapper">${langLabel}${copyBtn}<pre><code${langClass}>${escapeHtml(text)}</code></pre></div>`;
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const chatMarked = new Marked({
	renderer: new ChatRenderer(),
	gfm: true,
	breaks: true,
});

/**
 * Render markdown text to HTML for chat bubbles.
 * Returns sanitised HTML string.
 */
export function renderMarkdown(text: string): string {
	if (!text) return '';
	try {
		return chatMarked.parse(text) as string;
	} catch {
		// Fallback to plain text on parse errors
		return `<p>${escapeHtml(text)}</p>`;
	}
}
