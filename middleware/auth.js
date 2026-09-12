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

// 財務人員或管理員才能新增/修改/刪除財務資料；一般人員（'user'）僅能查詢
const requireEditor = (req, res, next) => {
    if (req.session && req.session.userId && (req.session.role === 'admin' || req.session.role === 'finance')) {
        return next();
    }
    return res.status(403).json({ error: '需要財務人員或管理員權限', authenticated: false });
};

module.exports = { requireAuth, requireAdmin, requireEditor };
