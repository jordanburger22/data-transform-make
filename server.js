const express = require('express');
const morgan = require('morgan');
const makeRouter = require('./routes/makeRouter');
require('dotenv').config();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT;

app.use(express.json());
app.use(morgan('dev'));
app.use(cors());

// Middleware to catch JSON parse errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON:', err);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next();
});

app.use('/wattsbags', makeRouter);

// Optional: Final error-handling middleware for any unhandled errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error('Error starting server:', err);
  } else {
    console.log(`Server running on PORT: ${PORT}`);
  }
});
