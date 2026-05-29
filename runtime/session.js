export function createSessionState(seed, rng = Math.random) {
  const reviews = [...seed.reviews];
  const fresh = [...seed.new];
  const queue = [];

  while (reviews.length || fresh.length) {
    const pickReview = reviews.length > 0 && (fresh.length === 0 || rng() < 0.8);
    queue.push(pickReview ? reviews.shift() : fresh.shift());
  }

  const kindById = Object.create(null);
  for (const card of seed.reviews) kindById[card.id] = "review";
  for (const card of seed.new) kindById[card.id] = "new";

  const ids = queue.map(card => card.id);
  const reviewIds = new Set(seed.reviews.map(card => card.id));
  return {
    queue,
    kindById,
    reviewIds,
    pendingReviewIds: new Set(reviewIds),
    seenIds: new Set(),
    remainingIds: new Set(ids),
    queuedIds: new Set(ids)
  };
}

export function nextSessionCard(session) {
  if (!session.queue.length) return null;
  const card = session.queue.shift();
  session.queuedIds.delete(card.id);
  return card;
}

export function recordSessionAnswer(session, card, correct) {
  if (!card || !session.remainingIds.has(card.id)) return { promotedToReview: false };
  if (correct) {
    session.remainingIds.delete(card.id);
    session.pendingReviewIds.delete(card.id);
    return { promotedToReview: false };
  }

  let promotedToReview = false;
  if (!session.reviewIds.has(card.id)) {
    session.reviewIds.add(card.id);
    session.pendingReviewIds.add(card.id);
    session.kindById[card.id] = "review";
    promotedToReview = true;
  }

  if (!session.queuedIds.has(card.id)) {
    session.queue.push(card);
    session.queuedIds.add(card.id);
  }
  return { promotedToReview };
}