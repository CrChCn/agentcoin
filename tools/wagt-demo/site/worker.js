export default {
  async fetch(req, env) {
    return env.ASSETS.fetch(req);
  },
};
