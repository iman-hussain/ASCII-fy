export const state = {
	selectedPath: null,
	videoMeta: null,
	videoFileSize: null,
	blobUrl: null,
	convertedGifUrl: null,
	convertedGifBlob: null,   // blob URL of current converted GIF
	convertedBundleUrl: null, // URL for the bundle.js file (HTML wrapper)
	convertedBundleJsUrl: null, // URL for the raw bundle.js file
	bundleTextCache: null,    // cached bundle.js content
	conversionStartTime: null,
	isConverting: false,
	lastConvertResult: null,  // last conversion done data
	lastConvertOptions: null,
	estimateScale: 1,
	gifHistory: [],           // { blobUrl, result } entries for undo
	webcamStream: null,
	mediaRecorder: null,
	recordedChunks: [],
	recordTimer: null,
	recordStartTime: 0,
	currentCameraIndex: 0,
	availableCameras: [],
	isCropping: false,
	framePreviewHtml: null,
	currentPreviewBg: '#000000',
	dragContext: null,
	qStep: 24
};

// Safe setters
export function setState(key, value) {
	if (key in state) {
		state[key] = value;
	}
}

export function resetState() {
	state.selectedPath = null;
	state.videoMeta = null;
	state.videoFileSize = null;
	state.convertedGifUrl = null;
	state.lastConvertResult = null;
	state.lastConvertOptions = null;
	state.estimateScale = 1;
	// Revoke previous URLs
	state.gifHistory.forEach(h => {
		if (h.blobUrl) URL.revokeObjectURL(h.blobUrl);
	});
	state.gifHistory.length = 0;
	if (state.blobUrl) { URL.revokeObjectURL(state.blobUrl); state.blobUrl = null; }
	// Revoke converted blob URLs
	if (state.convertedGifBlob instanceof Blob) {
		try { URL.revokeObjectURL(URL.createObjectURL(state.convertedGifBlob)); } catch { }
	}
	if (state.convertedBundleUrl && state.convertedBundleUrl.startsWith('blob:')) {
		URL.revokeObjectURL(state.convertedBundleUrl);
	}
	if (state.convertedBundleJsUrl && state.convertedBundleJsUrl.startsWith('blob:')) {
		URL.revokeObjectURL(state.convertedBundleJsUrl);
	}
	state.convertedGifBlob = null;
	state.convertedBundleUrl = null;
	state.convertedBundleJsUrl = null;
	state.framePreviewHtml = null;
	state.bundleTextCache = null;
	state.isCropping = false;
	state.dragContext = null;
}
