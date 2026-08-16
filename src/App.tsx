import { useEffect, useState, type ReactNode, useCallback } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import "./index.css";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import Analytics from "./pages/Analytics";
import Invoices from "./pages/Invoices";
import Website from "./pages/Website";
import PublicCleanerSite from "./pages/PublicCleanerSite";
import LegalModal from "./components/LegalModal";

const TERMS_VERSION = "2025-09-29";
function ProtectedRoute({user,loading,children}:{user:User|null|undefined;loading:boolean;children:ReactNode}) { const location=useLocation(); if(loading)return <div className="container mx-auto max-w-6xl px-4 sm:px-6 py-12">Loading...</div>; if(!user)return <Navigate to="/login" replace state={{from:location.pathname}}/>; return <>{children}</>; }
function TermsGate({children}:{children:ReactNode}) { const [checking,setChecking]=useState(true); const [ok,setOk]=useState(false); useEffect(()=>{(async()=>{const {data:{session}}=await supabase.auth.getSession(); if(!session?.user){setOk(false);setChecking(false);return;} const {data:row,error}=await supabase.from("cleaners").select("terms_accepted, terms_version").eq("user_id",session.user.id).maybeSingle(); if(error){console.error("Terms check failed",error);setOk(false);}else setOk(!!row?.terms_accepted&&row?.terms_version===TERMS_VERSION); setChecking(false);})();},[]); if(checking)return <div className="container mx-auto max-w-6xl px-4 sm:px-6 py-12">Loading...</div>; if(!ok)return <Navigate to="/onboarding" replace/>; return <>{children}</>; }
function NotFound(){return <div className="container mx-auto max-w-6xl px-4 sm:px-6 py-12"><h1 className="section-title text-2xl mb-2">404</h1><p className="muted">That page does not exist.</p></div>}
type LegalTab="terms"|"privacy"|"cookies"|"sponsored";
export default function App(){
 const [user,setUser]=useState<User|null|undefined>(undefined); const [legalOpen,setLegalOpen]=useState(false); const [legalTab,setLegalTab]=useState<LegalTab>("terms");
 const openLegal=useCallback((tab:LegalTab)=>{setLegalTab(tab);setLegalOpen(true)},[]); const closeLegal=useCallback(()=>setLegalOpen(false),[]);
 useEffect(()=>{const handler=(e:Event)=>{const ce=e as CustomEvent<{tab?:LegalTab}>;openLegal((ce?.detail?.tab as LegalTab)||"terms")};window.addEventListener("open-legal",handler as EventListener);return()=>window.removeEventListener("open-legal",handler as EventListener)},[openLegal]);
 useEffect(()=>{const params=new URLSearchParams(window.location.search);const checkout=params.get("checkout");if(checkout==="success"||checkout==="cancel"){const sessionId=params.get("session_id");const next=checkout==="success"?`/dashboard?checkout=success${sessionId?`&session_id=${encodeURIComponent(sessionId)}`:""}`:`/dashboard?checkout=cancel`;window.location.replace(next)}},[]);
 useEffect(()=>{supabase.auth.getSession().then(({data:{session}})=>setUser(session?.user??null));const {data:sub}=supabase.auth.onAuthStateChange((_e,session)=>setUser(session?.user??null));return()=>sub.subscription.unsubscribe()},[]);
 const loading=user===undefined;
 const protectedPage=(page:ReactNode)=><ProtectedRoute user={user} loading={loading}><TermsGate>{page}</TermsGate></ProtectedRoute>;
 return <Router><Routes><Route path="/cleaner/:slug" element={<PublicCleanerSite/>}/><Route path="*" element={<Layout><Routes><Route path="/" element={<Landing/>}/><Route path="/login" element={<Login/>}/><Route path="/onboarding" element={<Onboarding/>}/><Route path="/dashboard" element={protectedPage(<Dashboard/>)}/><Route path="/settings" element={protectedPage(<Settings/>)}/><Route path="/website" element={protectedPage(<Website/>)}/><Route path="/analytics" element={protectedPage(<Analytics/>)}/><Route path="/invoices" element={protectedPage(<Invoices/>)}/><Route path="/_debug" element={<div className="container mx-auto max-w-6xl px-4 sm:px-6 py-12">Router is working</div>}/><Route path="*" element={<NotFound/>}/></Routes><LegalModal open={legalOpen} onClose={closeLegal} defaultTab={legalTab}/></Layout>}/></Routes></Router>;
}
