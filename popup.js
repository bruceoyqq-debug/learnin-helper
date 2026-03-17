document.getElementById('open-btn').addEventListener('click', () => {
  chrome.tabs.create({
    url: 'https://www.learnin.com.cn/user/#/user/student'
  });
});
