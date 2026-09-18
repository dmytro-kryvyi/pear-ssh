(function () {
  var form = document.getElementById('form');
  var error = document.getElementById('error');
  var button = form.querySelector('button');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (res.ok) location.replace('/');
          else error.textContent = body.error || 'Sign-in failed';
        });
      })
      .catch(function () {
        error.textContent = 'Cannot reach the server';
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
