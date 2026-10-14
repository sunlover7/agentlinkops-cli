// One person-facing link type per monitored link, grouped into four families for the badge
// dot. The ids are the canonical classification roles plus `guest_post`, which only a
// person (or an agent acting for one) sets; the model's taxonomy is unchanged.
export const LINK_TYPE_FAMILIES = Object.freeze([
  {id: 'editorial', label: 'In content', types: ['contextual_citation', 'guest_post', 'recommendation', 'resource_entry', 'technical_reference']},
  {id: 'listing', label: 'Listings', types: ['directory_entry']},
  {id: 'community', label: 'Profiles and community', types: ['profile_website', 'author_attribution', 'discussion_contribution']},
  {id: 'sitewide', label: 'Site-wide', types: ['navigation_template', 'badge_embed_attribution', 'partner_sponsor']},
  {id: 'other', label: '', types: ['other']},
]);
export const LINK_TYPES = Object.freeze(LINK_TYPE_FAMILIES.flatMap(family => family.types));
export const LINK_TYPE_NAMES = Object.freeze({
  contextual_citation: 'Reference in content', guest_post: 'Guest post', recommendation: 'Recommendation',
  resource_entry: 'Resource list entry', technical_reference: 'Technical reference', directory_entry: 'Directory listing',
  profile_website: 'Profile link', author_attribution: 'Author credit or bio', discussion_contribution: 'Comment or forum post',
  navigation_template: 'Navigation or footer', badge_embed_attribution: 'Embedded credit', partner_sponsor: 'Partner or sponsor',
  other: 'Other',
});
export const linkTypeFamily = type => LINK_TYPE_FAMILIES.find(family => family.types.includes(type))?.id ?? 'other';
/**
 * Whole site vs one page by default, from the link type: disavowing all of medium.com or
 * patreon.com for one profile or comment is almost always a mistake.
 */
export const PAGE_ONLY_TYPES = Object.freeze(['profile_website', 'discussion_contribution', 'author_attribution']);
/** The six tag colours (the light-theme text colour of each pair), in the order new tags get them. */
export const TAG_COLORS = Object.freeze(['#075985', '#155e75', '#6b21a8', '#3730a3', '#9d174d', '#334155']);
