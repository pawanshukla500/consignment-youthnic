function safeErrorMessage(error, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return error?.message || fallback;
}

function sendSafeError(res, error, status = 500, fallback = 'Internal server error') {
  console.error(error);
  return res.status(status).json({ error: safeErrorMessage(error, fallback) });
}

module.exports = {
  safeErrorMessage,
  sendSafeError,
};
