// Vercel entry point: every /api/* request is rewritten here.
const { handle } = require('../server');
module.exports = (req, res) => handle(req, res);
