export default () => {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return { port, frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' };
};
