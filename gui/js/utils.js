import { dom } from './dom.js';

export function formatBytes(bytes) {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function appendLog(msg, type = 'info') {
	// Guard against DOM not being ready yet
	if (!dom.logBox) {
		// Queue the log for later or just skip it
		return;
	}

	const div = document.createElement('div');
	div.className = 'log-entry ' + type;

	// Add timestamp
	const timestamp = new Date().toLocaleTimeString('en-US', {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		fractionalSecondDigits: 3
	});

	const timeSpan = document.createElement('span');
	timeSpan.className = 'log-timestamp';
	timeSpan.textContent = `[${timestamp}] `;

	const msgSpan = document.createElement('span');
	msgSpan.className = 'log-message';
	msgSpan.textContent = msg;

	div.appendChild(timeSpan);
	div.appendChild(msgSpan);

	dom.logBox.appendChild(div);
	dom.logBox.scrollTop = dom.logBox.scrollHeight;
}

// Intercept console methods to mirror output to GUI
const originalConsole = {
	log: console.log,
	error: console.error,
	warn: console.warn,
	info: console.info,
	debug: console.debug
};

// Safe stringify with circular reference handling
function safeStringify(obj) {
	const seen = new WeakSet();
	return JSON.stringify(obj, (key, value) => {
		if (typeof value === 'object' && value !== null) {
			if (seen.has(value)) {
				return '[Circular]';
			}
			seen.add(value);
		}
		return value;
	}, 2);
}

// Format arguments for logging
function formatArgs(args) {
	try {
		return args.map(a => {
			if (a === null) return 'null';
			if (a === undefined) return 'undefined';
			if (typeof a === 'object') {
				try {
					if (a instanceof Error) {
						return a.stack || a.message || String(a);
					}
					return safeStringify(a);
				} catch (e) {
					return '[Object - could not stringify]';
				}
			}
			return String(a);
		}).join(' ');
	} catch (e) {
		return '[Error formatting log message]';
	}
}

export function interceptConsole() {
	console.log = function(...args) {
		originalConsole.log.apply(console, args);
		try {
			appendLog(formatArgs(args), 'info');
		} catch (e) {
			// Fail silently to avoid recursion
		}
	};

	console.error = function(...args) {
		originalConsole.error.apply(console, args);
		try {
			appendLog(formatArgs(args), 'error');
		} catch (e) {
			// Fail silently
		}
	};

	console.warn = function(...args) {
		originalConsole.warn.apply(console, args);
		try {
			appendLog(formatArgs(args), 'warning');
		} catch (e) {
			// Fail silently
		}
	};

	console.info = function(...args) {
		originalConsole.info.apply(console, args);
		try {
			appendLog(formatArgs(args), 'info');
		} catch (e) {
			// Fail silently
		}
	};

	console.debug = function(...args) {
		originalConsole.debug.apply(console, args);
		try {
			appendLog(formatArgs(args), 'info');
		} catch (e) {
			// Fail silently
		}
	};
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
