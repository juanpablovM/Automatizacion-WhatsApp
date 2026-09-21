const row = items[0]?.json ?? {};

if (row.should_send === false || row.already_sent === true) {
  return [{ json: row }];
}

if (row.human_arbitration_required === true) {
  // Only the first bot turn after an SLA expiry pays this cost. The database
  // performs the authoritative recheck in the next node.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

return [{ json: row }];
