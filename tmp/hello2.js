const colors = ['red', 'green', 'blue', 'yellow'];
const greet = (name) => `Hello, ${name}!`;
const name = colors[Math.floor(Math.random() * colors.length)];
console.log(greet(name), 'Color:', name, 'Random:', Math.random().toFixed(4));
