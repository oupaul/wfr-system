const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    return res.status(401).json({ error: '需要登入', authenticated: false });
};

const requireAdmin = (req, res, next) => {
    if (req.session && req.session.userId && req.session.role === 'admin') {
        return next();
    }
    return res.status(403).json({ error: '需要管理員權限', authenticated: false });
};

module.exports = { requireAuth, requireAdmin };
