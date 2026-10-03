const emojis = ['👋', '🌍', '🚀', '✨'];
const idx = Math.floor(Math.random() * emojis.length);
console.log(`${emojis[idx]} Hello world #${idx + 1}! Random:`, Math.random().toFixed(4));
