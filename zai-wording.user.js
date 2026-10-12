// ==UserScript==
// @name         Lilith wording for chat.z.ai
// @namespace    custom_joi
// @version      2.1
// @description  Button on chat.z.ai that puts the wording text into the chat input
// @match        https://chat.z.ai/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Edit the text between the comment markers below; anything goes except a closing comment marker
function wording() {/*
## 00 General
- Placeholder: the brief for an AI chat (chat.z.ai) writing lines in Lilith's voice
## 01 Her voice
- (placeholder) how she speaks, from custom_joi `docs/LILITH.md` → 05 Her voice
## 02 Format
- (placeholder) the JSON the lines come back in, from custom_joi `game/data/dialogue/README.md`
## 03 Wordings
- (placeholder) your own wordings in her voice, the seeds
*/}

(() => {
	'use strict';
	const source = wording.toString();
	const WORDING = source.slice(source.indexOf('/*') + 2, source.lastIndexOf('*/')).trim();

	// The chat input is framework-bound: set through the native setter, then tell the framework
	function insert() {
		const input = document.querySelector('#chat-input');
		if (!input) {
			flash('No chat input on this page');
			return;
		}
		const field = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement;
		if (!field && !input.isContentEditable) {
			flash('Chat input is not editable');
			return;
		}
		const inserted = field ? insertField(input) : insertEditable(input);
		flash(inserted ? 'Wording inserted' : 'Could not insert wording');
	}

	function insertField(input) {
		const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
		const before = input.value.trim();
		setter.call(input, before ? WORDING + '\n\n' + before : WORDING);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.focus();
		// Input types like email have no selection API
		if (input.selectionStart !== null) input.setSelectionRange(input.value.length, input.value.length);
		return true;
	}

	// Rich editors listen to native editing, so type the text at the start like a user would
	function insertEditable(input) {
		const before = input.textContent.trim();
		input.focus();
		const selection = getSelection();
		selection.selectAllChildren(input);
		selection.collapseToStart();
		if (!document.execCommand('insertText', false, before ? WORDING + '\n\n' : WORDING)) return false;
		selection.selectAllChildren(input);
		selection.collapseToEnd();
		return true;
	}

	function flash(text) {
		button.textContent = text;
		setTimeout(() => (button.textContent = 'Wording'), 1400);
	}

	const button = document.createElement('button');
	button.id = 'lilith-wording';
	button.textContent = 'Wording';
	button.title = 'Insert the wording text into the chat input';
	Object.assign(button.style, {
		position: 'fixed', right: '18px', bottom: '96px', zIndex: 99999,
		padding: '8px 14px', borderRadius: '12px', border: '1px solid #ff8fc8',
		background: '#2a1830', color: '#ffc6e4', font: '600 13px sans-serif', cursor: 'pointer',
		boxShadow: '0 2px 10px rgba(0,0,0,.35)',
	});
	button.addEventListener('click', insert);
	document.body.appendChild(button);
	// Page rerenders can drop the button
	setInterval(() => button.isConnected || document.body?.appendChild(button), 2000);
})();
