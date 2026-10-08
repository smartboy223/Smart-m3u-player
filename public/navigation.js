(function(root) {
  'use strict';
  function candidate(channels, currentId, direction, random = Math.random) {
    const eligible = channels.filter(channel => channel.test?.status !== 'failed');
    if (!eligible.length) return null;
    const index = eligible.findIndex(channel => channel.id === currentId);
    if (direction === 'shuffle') {
      const others = eligible.filter(channel => channel.id !== currentId);
      if (!others.length) return eligible[0].id;
      return others[Math.min(others.length - 1, Math.floor(random() * others.length))].id;
    }
    return eligible[index < 0 ? (direction < 0 ? eligible.length - 1 : 0) : (index + direction + eligible.length) % eligible.length].id;
  }
  const api = { candidate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChannelNavigation = api;
})(typeof window === 'undefined' ? null : window);
