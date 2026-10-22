import React from "react";
import { syncAuthIdentity } from "@/lib/authSession";

// 账户数据类型
type Account = {
  logged_in: boolean;
  sso_id: string;
  sso_type: string;
  username: string;
  uuid: string;
  "2fa_enabled": boolean;
};

// Context
interface AccountContextType{
    account: Account | null;
    loading: boolean;
    error: Error | null;
    refresh: () => Promise<void>;
}

// 创建Context

const AccountContext = React.createContext<AccountContextType | undefined>(undefined);

// Provider组件
export const AccountProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [account, setAccount] = React.useState<Account | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<Error | null>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
        const response = await fetch("/api/me", { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Failed to fetch account data");
        }
        const data: Account = await response.json();
        if (!mountedRef.current) return;
        setAccount(data);
        // 身份变化（登录/退出登录/切换账号）需要重建 RPC 连接并刷新身份相关数据。
        syncAuthIdentity({ loggedIn: data.logged_in, uuid: data.uuid ?? "" });
        } catch (err) {
        if (!mountedRef.current) return;
        setError(err as Error);
        } finally {
        if (mountedRef.current) {
            setLoading(false);
        }
        }
    }, []);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const value = React.useMemo(
        () => ({ account, loading, error, refresh }),
        [account, loading, error, refresh],
    );

    return (
        <AccountContext.Provider value={value}>
        {children}
        </AccountContext.Provider>
    );
}

// 自定义Hook
export const useAccount = () => {
    const context = React.useContext(AccountContext);
    if (!context) {
        throw new Error("useAccount must be used within an AccountProvider");
    }
    return context;
}
