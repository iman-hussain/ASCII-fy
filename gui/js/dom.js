export const $ = (s) => {
	const el = document.querySelector(s);
	if (!el) {
		console.warn(`DOM element not found: ${s}`);
	}
	return el;
};

export const dom = new Proxy({}, {
	get: (target, prop) => {
		if (prop in target) {
			return target[prop];
		}
		// These are the actual DOM references - we'll populate them lazily
		const selectorMap = {
			fileHeader: '#fileHeader',
			fileName: '#fileName',
			changeFileBtn: '#changeFileBtn',
			previewBox: '#previewBox',
			previewTabs: '#previewTabs',
			tabOriginal: '#tabOriginal',
			tabConvertedGif: '#tabConvertedGif',
			tabConvertedBundle: '#tabConvertedBundle',
			bundleViewer: '#bundleViewer',
			previewContent: '#previewContent',
			dropZone: '#dropZone',
			fileInput: '#fileInput',
			previewVideo: '#previewVideo',
			previewGif: '#previewGif',
			webcamBar: '#webcamBar',
			webcamBtn: '#webcamBtn',
			recordStartBtn: '#recordStartBtn',
			recordPauseBtn: '#recordPauseBtn',
			recordStopBtn: '#recordStopBtn',
			recordStatus: '#recordStatus',
			recordTimer: '#recordTimer',
			infoBar: '#infoBar',
			infoDims: '#infoDims',
			infoFps: '#infoFps',
			infoDuration: '#infoDuration',
			infoFrames: '#infoFrames',
			infoSize: '#infoSize',
			inputSelect: '#inputSelect',
			convertBtn: '#convertBtn',
			stopBtn: '#stopBtn',
			progressArea: '#progressArea',
			progressFill: '#progressFill',
			progressLabel: '#progressLabel',
			tabOriginalSize: '#tabOriginalSize',
			tabGifSize: '#tabGifSize',
			tabBundleSize: '#tabBundleSize',
			logArea: '#logArea',
			logBox: '#logBox',
			previewVideoContainer: '#previewVideoContainer',
			cropBox: '#cropBox',
			toggleCropBtn: '#toggleCropBtn',
			trimStartInp: '#start',
			trimEndInp: '#end',
			trimStartSlider: '#trimStartSlider',
			trimEndSlider: '#trimEndSlider',
			trimFillRail: '#trimFillRail',
			cropWInp: '#cropW',
			cropHInp: '#cropH',
			cropXInp: '#cropX',
			cropYInp: '#cropY',
			resultsArea: '#resultsArea',
			resultActions: '#resultActions',
			undoBtn: '#undoBtn',
			estimateArea: '#estimateArea',
			estimateVal: '#estimateVal',
			previewBgBar: '#previewBgBar',
			previewBgCustom: '#previewBgCustom',
			paletteSwatch: '#paletteSwatch',
			widthSlider: '#width',
			widthVal: '#widthVal',
			heightSlider: '#height',
			heightVal: '#heightVal',
			lockAspectChk: '#lockAspect',
			fpsSlider: '#fps',
			fpsVal: '#fpsVal',
			modeSelect: '#mode',
			colourSubOptions: '#colourSubOptions',
			paletteRow: '#paletteRow',
			depthRow: '#depthRow',
			depthSlider: '#depth',
			depthValEl: '#depthVal',
			monoFgRow: '#monoFgRow',
			monoBgRow: '#monoBgRow',
			bundleIframe: '#bundleIframe',
			showRawJsBox: '#showRawJsBox',
			showRawJsChk: '#showRawJs',
			rawJsToggle: '#rawJsToggle',
			fgInput: '#fg',
			fgValEl: '#fgVal',
			bgInput: '#bg',
			bgValEl: '#bgVal',
			fgSubOptions: '#fgSubOptions',
			fgMode: '#fgMode',
			fgBackground: '#fgBackground',
			fgThreshold: '#fgThreshold',
			fgThresholdVal: '#fgThresholdVal',
			fgBgRow: '#fgBgRow',
			fgBgInput: '#fgBg',
			fgBgVal: '#fgBgVal',
			fgThresholdRow: '#fgThresholdRow',
			fgThresholdLabel: '#fgThresholdLabel',
			fgIsolationRow: '#fgIsolationRow',
			brightSlider: '#brightnessAdj',
			brightVal: '#brightVal',
			contrastSlider: '#contrastAdj',
			contrastVal: '#contrastVal',
			trimStartVal: '#trimStartVal',
			trimEndVal: '#trimEndVal',
			charMode: '#charMode',
			skipGif: '#skipGif',
			paletteSelect: '#palette',
			detailSlider: '#detail',
			detailVal: '#detailVal',
			detailRow: '#detailRow',
			qStepRow: '#qStepRow',
			qStepSlider: '#qStep',
			qStepValEl: '#qStepVal',
		};

		if (prop in selectorMap) {
			const selector = selectorMap[prop];
			const el = document.querySelector(selector);
			target[prop] = el;
			if (!el) {
				console.warn(`DOM element not found: ${selector}`);
			}
			return el;
		}
		return undefined;
	}
});
