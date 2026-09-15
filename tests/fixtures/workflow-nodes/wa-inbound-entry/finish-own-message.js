// A handled own-message event must not fall through to the customer dispatcher.
// Returning zero items also makes a recovery subworkflow stop at this boundary.
return [];
