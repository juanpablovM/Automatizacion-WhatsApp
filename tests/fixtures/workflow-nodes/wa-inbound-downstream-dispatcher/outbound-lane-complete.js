return items.map((item) => ({
  json: { ...(item.json || {}), outbound_lane_complete: true },
}));
