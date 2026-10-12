// ==UserScript==
// @name         z.ai wide layout
// @namespace    zism
// @version      1.0.1
// @downloadURL  https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/zai-layout.user.js
// @updateURL    https://raw.githubusercontent.com/USER-NOT-GENERATED/userscripts/main/zai-layout.user.js
// @description  chat.z.ai: wider message column and input, input keeps the height of its text
// @match        https://chat.z.ai/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
	'use strict';

	// Readable line length on 1920 px; narrow windows keep a margin
	const WIDTH = 'min(1300px, calc(100% - 48px))';
	// Input grows with its text up to this share of the window, then scrolls
	const INPUT_MAX = 0.45;

	const style = document.createElement('style');
	style.id = 'zai-layout';
	// z.ai caps messages at 808/894 px and the input at 768/854 px (794 px wrapper on a new chat) through Tailwind classes
	style.textContent = `
		#messages-container [class*="max-w-[808px]"],
		.messageInputContainer [class*="max-w-[768px]"],
		.placeholder-input[class*="max-w-[794px]"] {
			max-width: ${WIDTH} !important;
		}
		#chat-input {
			max-height: ${INPUT_MAX * 100}vh !important;
		}
	`;
	// At document-start the root element may not exist yet
	const addStyle = () => {
		const root = document.head || document.documentElement;
		if (!root) return false;
		if (!style.isConnected) root.append(style);
		return true;
	};
	if (!addStyle()) new MutationObserver((_, observer) => addStyle() && observer.disconnect()).observe(document, { childList: true });

	// The site sets the input height inline and sometimes shrinks it below its text; size it from the text instead.
	// Our own writes happen with the observer off, so every observed change is the site's
	const options = { attributes: true, attributeFilter: ['style', 'rows', 'class'] };
	const fit = (input) => {
		sizes.disconnect();
		const cap = Math.round(window.innerHeight * INPUT_MAX);
		input.style.height = 'auto';
		input.style.height = Math.min(input.scrollHeight, cap) + 'px';
		sizes.observe(input, options);
	};
	const sizes = new MutationObserver((records) => fit(records[0].target));

	let watched = null;
	let width = 0;
	// Text rewraps when the column changes width, e.g. the sidebar opens
	const widths = new ResizeObserver(([entry]) => {
		if (Math.round(entry.contentRect.width) === width) return;
		width = Math.round(entry.contentRect.width);
		fit(entry.target);
	});
	const attach = () => {
		const input = document.getElementById('chat-input');
		if (!input || input === watched || input.tagName !== 'TEXTAREA') return;
		watched = input;
		widths.disconnect();
		widths.observe(input);
		input.addEventListener('input', () => fit(input));
		// Sending clears the text without an input event
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) setTimeout(() => fit(input), 50);
		});
		fit(input);
	};
	document.addEventListener('click', (event) => {
		if (watched && event.target.closest?.('#send-message-button')) setTimeout(() => fit(watched), 50);
	}, true);

	// Svelte replaces the input on navigation between chats
	new MutationObserver(attach).observe(document, { childList: true, subtree: true });
	window.addEventListener('resize', () => watched && fit(watched));
	attach();
})();
