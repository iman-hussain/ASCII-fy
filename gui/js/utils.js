import { dom } from './dom.js';

export function formatBytes(bytes) {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function appendLog(msg, type = 'info') {
	const div = document.createElement('div');
	div.className = 'log-entry ' + type;
	div.textContent = msg;
	dom.logBox.appendChild(div);
	dom.logBox.scrollTop = dom.logBox.scrollHeight;
}

export function safeHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function downloadBlob(blobUrl, filename) {
	const a = document.createElement('a');
	a.href = blobUrl;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

// Draggable Modal Logic for pure UI helper
export function makeDraggable(el, handle) {
	let isDragging = false;
	let startX, startY, initialX, initialY;

	handle.addEventListener('mousedown', (e) => {
		if (e.target.tagName === 'BUTTON') return;
		isDragging = true;
		startX = e.clientX;
		startY = e.clientY;
		const rect = el.getBoundingClientRect();
		initialX = rect.left;
		initialY = rect.top;
		el.style.margin = '0';
		el.style.left = initialX + 'px';
		el.style.top = initialY + 'px';
		el.style.transform = 'none';
	});

	document.addEventListener('mousemove', (e) => {
		if (!isDragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		el.style.left = (initialX + dx) + 'px';
		el.style.top = (initialY + dy) + 'px';
	});

	document.addEventListener('mouseup', () => {
		isDragging = false;
	});
}
