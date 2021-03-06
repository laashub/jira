module.exports = async (req, res, next) => {
  if (!req.session.githubToken) {
    return next(new Error('Unauthorized'))
  }

  const { github, client, isAdmin } = res.locals

  try {
    const { data: { login } } = await github.users.get()
    const {
      data: { installations }
    } = await github.users.getInstallations({})

    const adminInstallations = []
    for (const installation of installations) {
      // See if we can get the membership for this user
      if (
        await isAdmin({
          org: installation.account.login,
          username: login,
          type: installation.target_type
        })
      ) {
        adminInstallations.push(installation)
      }
    }

    const { data: info } = await client.apps.get({})
    return res.render('github-installations.hbs', {
      csrfToken: req.csrfToken(),
      installations: adminInstallations,
      info
    })
  } catch (err) {
    console.log(
      `Unable to show github subscription page. error=${err}, jiraHost=${req.session.jiraHost}`
    )
    return next(new Error(err))
  }
}
