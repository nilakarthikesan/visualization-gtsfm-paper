// Use the dataset key so individual Brussels branches remain distinguishable.
export function recordingFilename(datasetKey, date = new Date(), mimeType = 'video/webm') {
    const name = datasetKey === 'original' ? 'gerrard-hall' : datasetKey || 'reconstruction';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const timestamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    return `${slug}-recording-${timestamp}.${extension}`;
}

// Keep the encoded dimensions fixed even if the viewer resizes during recording.
// Copy immediately after WebGL rendering, before its drawing buffer is discarded.
export function drawRecordingFrame(context, source, guides) {
    const { width, height } = context.canvas;
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    const bounds = source.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    context.save();
    context.scale(width / bounds.width, height / bounds.height);
    context.translate(-bounds.left, -bounds.top);
    guides?.drawToCanvas(context);
    context.restore();
}
