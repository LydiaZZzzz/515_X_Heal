import { useState, useEffect } from 'react'
import { collection, addDoc, getDocs, query, orderBy, limit, doc, updateDoc, setDoc } from 'firebase/firestore';
import { db, storage } from './firebase';
import './App.css'
import jsPDF from 'jspdf';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

function App() {
  // 状态变量
  const [isConnected, setIsConnected] = useState(false)  // 蓝牙连接状态
  const [receivedNumber, setReceivedNumber] = useState(null)  // 接收到的数字
  const [device, setDevice] = useState(null)  // 蓝牙设备对象
  const [numbersList, setNumbersList] = useState([])  // 存储接收到的数字
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const [characteristic, setCharacteristic] = useState(null)  // 存储特征值对象
  const [dataGroups, setDataGroups] = useState([])  // 存储数据组
  const [lastReport, setLastReport] = useState(null); // 保存最近一份报告

  // 当收到新数字时，添加到列表中并检查是否需要分组
  useEffect(() => {
    if (receivedNumber !== null) {
      const newNumber = parseInt(receivedNumber);
      setNumbersList(prev => {
        const newList = [...prev, newNumber];
        // 如果累积了20个数，创建新的组
        if (newList.length >= 20) {
          const groupData = newList.slice(-20);
          setDataGroups(prev => [...prev, groupData]);
          return []; // 清空当前列表，开始收集新的一组
        }
        return newList;
      });
    }
  }, [receivedNumber]);

  // 页面加载时从Firebase获取最新一份报告
  useEffect(() => {
    const fetchLatestReport = async () => {
      const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'), limit(1));
      const querySnapshot = await getDocs(q);
      if (!querySnapshot.empty) {
        const doc = querySnapshot.docs[0];
        setLastReport(doc.data());
      }
    };
    fetchLatestReport();
  }, []);

  // 连接蓝牙设备
  const connectDevice = async () => {
    try {
      // 请求蓝牙设备
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'XIAO' }  // 匹配设备名称前缀为 XIAO 的设备
        ],
        optionalServices: ['4fafc201-1fb5-459e-8fcc-c5c9c331914b'] // 你的ESP32服务UUID
      });

      setDevice(device);
      console.log('设备已选择:', device.name);

      // 连接到设备
      const server = await device.gatt.connect();
      console.log('已连接到GATT服务器');

      // 获取服务
      const service = await server.getPrimaryService('4fafc201-1fb5-459e-8fcc-c5c9c331914b');
      console.log('已获取服务');

      // 获取特征值
      const char = await service.getCharacteristic('beb5483e-36e1-4688-b7f5-ea07361b26a8');
      console.log('已获取特征值');

      setCharacteristic(char);  // 保存特征值对象

      // 启动通知
      await char.startNotifications();
      console.log('已启动通知');

      // 处理接收到的数据
      char.addEventListener('characteristicvaluechanged', (event) => {
        const value = event.target.value;
        const decoder = new TextDecoder('utf-8');
        const data = decoder.decode(value);
        console.log('收到数据:', data);
        setReceivedNumber(data);
      });

      setIsConnected(true);

    } catch (error) {
      console.error('蓝牙连接错误:', error);
      setIsConnected(false);
    }
  };

  // 停止数据收集
  const stopDataCollection = async () => {
    if (characteristic) {
      try {
        // 发送停止信号到ESP32
        const encoder = new TextEncoder();
        const data = encoder.encode('stop');
        await characteristic.writeValue(data);
        console.log('已发送停止信号');
      } catch (error) {
        console.error('发送停止信号失败:', error);
      }
    }
  };

  const generateReport = async () => {
    let allGroups = [...dataGroups];
    if (numbersList.length > 0) {
      allGroups = [...allGroups, numbersList];
    }

    setIsGeneratingReport(true);
    try {
      await stopDataCollection();
      const groupsAnalysis = allGroups.map((group, index) => {
        const max = Math.max(...group);
        const min = Math.min(...group);
        const average = group.reduce((a, b) => a + b, 0) / group.length;
        const evaluation = average > 5500 ? "Well done" : "Needs improvement";
        return {
          groupId: index + 1, // groupId starts from 1
          maxValue: max,
          minValue: min,
          average: average,
          evaluation: evaluation,
          data: group
        };
      });

      // 生成自定义ID（上传时间戳）
      const now = new Date();
      const customId = now.toISOString().replace(/[:.]/g, '-');
      const report = {
        timestamp: now,
        customName: customId,
        totalGroups: groupsAnalysis.length,
        overallEvaluation: groupsAnalysis.reduce((acc, group) => 
          acc + (group.average > 5500 ? 1 : 0), 0) / groupsAnalysis.length > 0.5 
          ? "Excellent overall performance" : "Needs more effort",
        groups: groupsAnalysis
      };

      // 用 setDoc 和自定义ID上传
      await setDoc(doc(db, "reports", customId), report);
      alert(`Report generated and uploaded!\nCustom ID: ${customId}`);

      setLastReport(report); // 保存最近一次报告
      setNumbersList([]);
      setDataGroups([]);
    } catch (error) {
      console.error("上传报告错误:", error);
      alert('Failed to generate report: ' + error.message);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  // 导出PDF并上传到Storage
  const exportPDF = async () => {
    if (!lastReport) return;
    const docPDF = new jsPDF();
    docPDF.setFontSize(16);
    docPDF.text('Health Sensor Daily Report', 10, 15);
    docPDF.setFontSize(10);
    const timestamp = lastReport.timestamp.seconds ? new Date(lastReport.timestamp.seconds * 1000) : new Date(lastReport.timestamp);
    const customName = timestamp.toISOString().replace(/[:.]/g, '-');
    docPDF.text(`Generated at: ${timestamp.toLocaleString()}`, 10, 25);
    docPDF.text(`Total Groups: ${lastReport.totalGroups}`, 10, 32);
    docPDF.text(`Overall Evaluation: ${lastReport.overallEvaluation}`, 10, 39);
    let y = 48;
    lastReport.groups.forEach(group => {
      docPDF.text(`Group ${group.groupId}:`, 10, y);
      docPDF.text(`Max: ${group.maxValue}  Min: ${group.minValue}  Avg: ${group.average.toFixed(2)}  Evaluation: ${group.evaluation}`, 20, y + 7);
      y += 16;
      if (y > 270) { docPDF.addPage(); y = 20; }
    });
    // 生成PDF的Blob
    const pdfBlob = docPDF.output('blob');
    // 上传到Storage
    const pdfFileName = `${customName}-HealthReport.pdf`;
    const pdfRef = ref(storage, `reports/${pdfFileName}`);
    await uploadBytes(pdfRef, pdfBlob);
    const pdfUrl = await getDownloadURL(pdfRef);
    // 更新Firestore中最新报告的pdfUrl字段
    // 先查到最新文档ID
    const q = query(collection(db, 'reports'), orderBy('timestamp', 'desc'), limit(1));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) {
      const reportDoc = querySnapshot.docs[0];
      await updateDoc(doc(db, 'reports', reportDoc.id), { pdfUrl, customName });
      alert('PDF uploaded to Firebase Storage and url saved to Firestore!');
    }
    // 本地下载
    docPDF.save(pdfFileName);
  };

  return (
    <div className="container">
      <header className="header">
        <h1>蓝牙测试</h1>
      </header>
      
      <main className="main-content">
        <div className="card">
          <h2>接收到的数据</h2>
          
          {/* 显示接收到的数字 */}
          <div className="sensor-values">
            <div className="sensor-value">
              <label>当前数字:</label>
              <span>{receivedNumber || '等待数据...'}</span>
            </div>
            <div className="sensor-value">
              <label>当前组数据点:</label>
              <span>{numbersList.length}/20</span>
            </div>
            <div className="sensor-value">
              <label>已完成组数:</label>
              <span>{dataGroups.length}</span>
            </div>
          </div>

          {/* 连接按钮 */}
          <button 
            className="connect-button"
            onClick={connectDevice}
            disabled={isConnected}
          >
            {isConnected ? '已连接' : '连接设备'}
          </button>

          <button 
            className="connect-button"
            onClick={generateReport}
            disabled={!isConnected || isGeneratingReport || (numbersList.length === 0 && dataGroups.length === 0)}
          >
            {isGeneratingReport ? '生成报告中...' : '生成日报'}
          </button>

          <button
            className="connect-button"
            onClick={exportPDF}
            disabled={!lastReport}
            style={{ marginTop: '10px', background: '#4caf50', color: 'white' }}
          >
            Export & Upload Latest Report PDF
          </button>

          {/* 连接状态显示 */}
          {device && (
            <div className="device-info">
              <p>已连接设备: {device.name}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default App 