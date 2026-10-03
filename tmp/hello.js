const messages = [
  'Hello from file 1!',
  'Greetings, world!',
  'Hi there!',
  'Salutations, friend!'
];
const pick = messages[Math.floor(Math.random() * messages.length)];
console.log(pick, 'Random:', Math.random().toFixed(4));
