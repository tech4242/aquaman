// A link with data-check="<id>" also selects that radio button, so "How to
// set it up" lands on the right tab. Without this script the link still
// scrolls to the picker.
document.addEventListener('click', function (event) {
  var link = event.target.closest && event.target.closest('[data-check]');
  var input = link && document.getElementById(link.getAttribute('data-check'));
  if (input) input.checked = true;
});
