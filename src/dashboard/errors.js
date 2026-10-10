function getValidationDetails(error) {
  if (error?.name === 'ValidationError' && error.errors) {
    return Object.fromEntries(Object.entries(error.errors).map(([path, issue]) => [path, {
      message: issue.message,
      kind: issue.kind,
    }]));
  }
  if (error?.name === 'CastError' && error.path) {
    return { [error.path]: { message: error.message, kind: error.kind } };
  }
  return undefined;
}

function getDashboardErrorStatus(error) {
  if (error?.name === 'ValidationError' || error?.name === 'CastError') return 400;
  const status = error?.statusCode || error?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
}

function getDashboardErrorResponse(error, status) {
  const validationErrors = getValidationDetails(error);
  if (status === 500) return { error: 'Internal server error.' };
  return {
    error: error.message || 'The request could not be processed.',
    ...(validationErrors ? { details: validationErrors } : {}),
  };
}

module.exports = { getDashboardErrorResponse, getDashboardErrorStatus, getValidationDetails };
